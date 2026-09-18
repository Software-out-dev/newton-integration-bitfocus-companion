import type { CompanionActionDefinitions, InstanceBase } from '@companion-module/base'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NewtonActionClient } from './action-client.js'
import type { GainReadState, NewtonActionResult } from './protocol/types.js'
import { QueueRejectionError, type NewtonCommandResult, type SendCommandExpectOptions } from './protocol/tcp-client.js'
import { SETTINGS } from './settings.js'

type ActionLogger = Pick<InstanceBase<never>, 'log'> & {
	reportActionResult?: (result: NewtonActionResult) => void
	reportGainRead?: (channelType: number, channelIndex: number, state: GainReadState) => void
}

interface ActionExecution {
	deadline: number
	active: boolean
}

const executions = new AsyncLocalStorage<ActionExecution>()

function expiredError(): QueueRejectionError {
	return new QueueRejectionError(
		`Action exceeded its ${SETTINGS.actionCallbackBudgetMs}ms Companion callback budget; completion is not confirmed. Commands already sent may still take effect.`,
		'expired',
	)
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function remainingTime(): number | null {
	const execution = executions.getStore()
	if (!execution) return null
	const remaining = execution.deadline - Date.now()
	if (!execution.active || remaining <= 0) throw expiredError()
	return remaining
}

/** Keep a deferred queue callback attached to the button press that created it. */
export function bindCurrentActionExecution<TArgs extends unknown[], TResult>(
	callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
	const execution = executions.getStore()
	if (!execution) return callback
	return (...args) => executions.run(execution, () => callback(...args))
}

/**
 * Apply the host callback deadline to every command issued by an action.
 * Queued commands expire at the remaining budget. A command already on the
 * wire keeps its transport timeout so legacy reply framing remains sound, but
 * its late result cannot authorize a subsequent command.
 */
export function actionExecutionClient(client: NewtonActionClient): NewtonActionClient {
	return {
		async sendCommandExpect<TParsed = Buffer>(
			cmd: Buffer,
			options: SendCommandExpectOptions<TParsed> = {},
		): Promise<NewtonCommandResult<TParsed>> {
			const remaining = remainingTime()
			const result = await client.sendCommandExpect(cmd, {
				...options,
				...(remaining === null ? {} : { queueTtlMs: Math.min(options.queueTtlMs ?? remaining, remaining) }),
			})
			remainingTime()
			return result
		},
	}
}

/** Suppress diagnostics and state publications from an action after expiry. */
export function actionExecutionLogger(logger: ActionLogger): ActionLogger {
	return {
		log: (level, message) => {
			try {
				remainingTime()
				logger.log(level, message)
			} catch {
				// The deadline handler already published the final failure.
			}
		},
		reportActionResult: (result) => {
			try {
				remainingTime()
				logger.reportActionResult?.(result)
			} catch {
				// Ignore stale Last Action updates.
			}
		},
		reportGainRead: (...args) => {
			try {
				remainingTime()
				logger.reportGainRead?.(...args)
			} catch {
				// Ignore stale gain state from an expired action.
			}
		},
	}
}

export function enforceActionCallbackBudget(
	definitions: CompanionActionDefinitions,
	logger: ActionLogger,
): CompanionActionDefinitions {
	for (const definition of Object.values(definitions)) {
		if (!definition) continue
		const callback = definition.callback
		definition.callback = async (action, context) => {
			const execution: ActionExecution = {
				deadline: Date.now() + SETTINGS.actionCallbackBudgetMs,
				active: true,
			}
			let timer: ReturnType<typeof setTimeout> | null = null
			await new Promise<void>((resolve, reject) => {
				const finalizeExpiry = (): void => {
					if (timer) clearTimeout(timer)
					timer = null
					if (!execution.active) return
					execution.active = false
					const error = expiredError().message
					logger.log('error', `${definition.name}: ${error}`)
					logger.reportActionResult?.({
						name: definition.name,
						success: false,
						responseHex: '',
						error,
						controlId: action.controlId,
					})
					resolve()
				}
				// Register the host-budget timer before invoking user action code. A
				// nested queue may install a timer for the same absolute deadline.
				timer = setTimeout(finalizeExpiry, SETTINGS.actionCallbackBudgetMs)
				let work: Promise<void>
				try {
					work = executions.run(execution, async () => {
						await callback(action, context)
					})
				} catch (error) {
					work = Promise.reject(toError(error))
				}
				work.then(
					() => {
						if (!execution.active) return
						if (Date.now() >= execution.deadline) {
							finalizeExpiry()
							return
						}
						execution.active = false
						if (timer) clearTimeout(timer)
						timer = null
						resolve()
					},
					(error: unknown) => {
						if (!execution.active) return
						if (Date.now() >= execution.deadline) {
							finalizeExpiry()
							return
						}
						execution.active = false
						if (timer) clearTimeout(timer)
						timer = null
						reject(toError(error))
					},
				)
			})
		}
	}
	return definitions
}
