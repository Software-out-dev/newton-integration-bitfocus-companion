import type { NewtonActionClient } from './action-client.js'
import { bindCurrentActionExecution } from './action-execution.js'
import { QueueRejectionError, type NewtonCommandResult, type SendCommandExpectOptions } from './protocol/tcp-client.js'
import { SETTINGS } from './settings.js'

interface GainOperation {
	key: string
	generation: number
	deadline: number
	client: NewtonActionClient
	run: (client: NewtonActionClient, isCurrent: () => boolean) => Promise<void>
	resolve: () => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout> | null
	state: 'pending' | 'expired' | 'cancelled' | 'settled'
}

/**
 * Serializes complete gain/mute transactions per channel, with a per-instance
 * bound on active AND waiting operations. The deadline starts at the button
 * press and is shared by the channel queue, TCP queue and every later send.
 * A command already on the wire keeps its normal response timeout; it must
 * settle before the channel lock can be released safely.
 */
export class GainMutationQueue {
	private readonly active = new Map<string, GainOperation>()
	private readonly waiting: GainOperation[] = []
	private generation = 0
	private cancellationReason = 'device session ended'

	constructor(
		private readonly ttlMs = SETTINGS.actionCallbackBudgetMs,
		private readonly maxPending = 32,
	) {}

	async enqueue(client: NewtonActionClient, key: string, run: GainOperation['run']): Promise<void> {
		if (this.active.size + this.waiting.length >= this.maxPending) {
			throw new QueueRejectionError(`Gain/mute queue is full (maximum ${this.maxPending} pending operations)`, 'full')
		}
		return new Promise<void>((resolve, reject) => {
			const operation: GainOperation = {
				key,
				generation: this.generation,
				deadline: Date.now() + this.ttlMs,
				client,
				run: bindCurrentActionExecution(run),
				resolve,
				reject,
				timer: null,
				state: 'pending',
			}
			this.waiting.push(operation)
			operation.timer = setTimeout(() => this.expire(operation), this.ttlMs)
			this.startNext(key)
		})
	}

	/** Discard queued presses and prevent active reads from issuing later writes. */
	cancel(reason: string): void {
		this.generation++
		this.cancellationReason = reason
		for (const operation of this.waiting.splice(0)) {
			this.cancelOperation(operation)
		}
		for (const operation of this.active.values()) {
			this.cancelOperation(operation)
		}
		// Do not release active locks early: their wire commands may still be
		// settling. New work on the same channel waits for that completion.
	}

	private startNext(key: string): void {
		if (this.active.has(key)) return
		const index = this.waiting.findIndex((operation) => operation.key === key)
		if (index < 0) return
		const [operation] = this.waiting.splice(index, 1)
		this.active.set(key, operation)
		void this.execute(operation)
	}

	private async execute(operation: GainOperation): Promise<void> {
		try {
			this.remainingTime(operation)
			const client = this.scopedClient(operation)
			await operation.run(client, () => this.isCurrent(operation))
			if (operation.state !== 'pending') return
			operation.state = 'settled'
			operation.resolve()
		} catch (error) {
			if (operation.state === 'pending') {
				operation.state = 'settled'
				operation.reject(error instanceof Error ? error : new Error(String(error)))
			}
		} finally {
			if (operation.timer) clearTimeout(operation.timer)
			operation.timer = null
			this.active.delete(operation.key)
			this.startNext(operation.key)
		}
	}

	private scopedClient(operation: GainOperation): NewtonActionClient {
		return {
			sendCommandExpect: async <TParsed = Buffer>(
				cmd: Buffer,
				options: SendCommandExpectOptions<TParsed> = {},
			): Promise<NewtonCommandResult<TParsed>> => {
				const remaining = this.remainingTime(operation)
				const queueBudget = remaining
				const result = await operation.client.sendCommandExpect(cmd, {
					...options,
					queueTtlMs: Math.min(options.queueTtlMs ?? queueBudget, queueBudget),
				})
				this.remainingTime(operation)
				return result
			},
		}
	}

	private expire(operation: GainOperation): void {
		if (operation.state !== 'pending') return
		const index = this.waiting.indexOf(operation)
		if (index >= 0) this.waiting.splice(index, 1)
		operation.timer = null
		operation.state = 'expired'
		operation.reject(this.expiredError())
	}

	private cancelOperation(operation: GainOperation): void {
		if (operation.state !== 'pending') return
		if (operation.timer) clearTimeout(operation.timer)
		operation.timer = null
		operation.state = 'cancelled'
		operation.reject(this.cancelledError())
	}

	private remainingTime(operation: GainOperation): number {
		if (operation.state === 'expired') throw this.expiredError()
		if (operation.state === 'cancelled') throw this.cancelledError()
		if (operation.generation !== this.generation) throw this.cancelledError()
		const remaining = operation.deadline - Date.now()
		if (remaining <= 0) throw this.expiredError()
		return remaining
	}

	private isCurrent(operation: GainOperation): boolean {
		return operation.state === 'pending' && operation.generation === this.generation && operation.deadline > Date.now()
	}

	private expiredError(): QueueRejectionError {
		return new QueueRejectionError(`Gain/mute operation expired after ${this.ttlMs}ms`, 'expired')
	}

	private cancelledError(): Error {
		return new Error(`Gain/mute operation cancelled: ${this.cancellationReason}`)
	}
}
