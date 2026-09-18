/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { getActionDefinitions } from '../dist/actions.js'
import { bindActionClient } from '../dist/action-client.js'
import { GainMutationQueue } from '../dist/gain-mutation-queue.js'
import { NewtonSession } from '../dist/newton-session.js'
import { NewtonInstance } from '../dist/instance.js'
import { DEFAULT_CONFIG } from '../dist/config.js'
import { SETTINGS } from '../dist/settings.js'
import { ChannelType, SnapshotApplyMode } from '../dist/protocol/constants.js'
import { PRESET_AUDIO_RESPONSE_LENGTH } from '../dist/protocol/command-parser.js'
import { NewtonTcpClient } from '../dist/protocol/tcp-client.js'

const ack = Buffer.from([0x33, 0])
const preset = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
preset[0] = 0x33
preset.writeFloatLE(-6, 2 + 1008)

function deferred() {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function flush() {
	// Drain the nested async action/transport continuations without advancing time.
	for (let i = 0; i < 30; i++) await Promise.resolve()
}

function definitions(client, queue = new GainMutationQueue(), results = []) {
	return getActionDefinitions(
		bindActionClient(client, SETTINGS.commandTimeoutMs, SETTINGS.actionQueueTtlMs),
		{ log() {}, reportActionResult: (result) => results.push(result) },
		new Map(),
		new Map(),
		[],
		new Map([['button', { channelType: ChannelType.InputDsp, channelIndex: 0 }]]),
		() => false,
		() => false,
		queue,
	)
}

function press(actions, kind = 'adjust_gain', channel = 1) {
	const options = {
		adjust_gain: { channelType: ChannelType.InputDsp, channel, direction: 'up', deltaDb: 1 },
		set_gain: { channelType: ChannelType.InputDsp, channelIndex: channel, gainDb: -6, mute: false },
		set_channel_mute: { channelType: ChannelType.InputDsp, channel, mode: 'toggle' },
		mute_this_channel: { mode: 'toggle' },
	}
	return actions[kind].callback({ controlId: 'button', options: options[kind] })
}

function fakeClient(firstRead) {
	const sent = []
	return {
		sent,
		async sendCommandExpect(cmd, options) {
			sent.push({ cmd, options })
			if (sent.length === 1 && firstRead) await firstRead
			const rx = cmd[0] === 0x21 ? preset : ack
			return { success: true, rx, parsed: options?.parser?.(rx) ?? null }
		},
	}
}

class FakeSocket extends EventEmitter {
	isConnected = true
	sent = []
	send(cmd) {
		this.sent.push(cmd)
		return Promise.resolve(true)
	}
	destroy() {
		this.isConnected = false
	}
}

test('gain/mute admission is bounded across channels, action types and definition refreshes', async () => {
	const read = deferred()
	const client = fakeClient(read.promise)
	const queue = new GainMutationQueue()
	const results = []
	const oldDefinitions = definitions(client, queue, results)
	const pending = [press(oldDefinitions)]
	const refreshedDefinitions = definitions(client, queue, results)
	const kinds = ['adjust_gain', 'set_gain', 'set_channel_mute', 'mute_this_channel']
	for (let i = 1; i < 40; i++) pending.push(press(refreshedDefinitions, kinds[i % kinds.length]))
	await flush()
	assert.equal(client.sent.length, 1, 'same-channel operations retain the lock across definition refreshes')
	assert.equal(results.length, 8)
	assert.ok(results.every((result) => !result.success && /queue is full/.test(result.error)))
	await press(refreshedDefinitions, 'set_gain', 2)
	assert.match(results.at(-1).error, /queue is full/, 'the limit is per connection, not per channel')
	read.resolve()
	await Promise.all(pending)
	assert.equal(results.filter((result) => result.success).length, 32)
	assert.equal(results.filter((result) => !result.success).length, 9)
	await press(refreshedDefinitions, 'set_gain', 2)
	assert.equal(results.at(-1).success, true, 'capacity is released after completion')
})

test('a slow preset read returns before the Companion host timeout and never issues a late write', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const read = deferred()
	const client = fakeClient(read.promise)
	const results = []
	const actions = definitions(client, new GainMutationQueue(), results)
	const action = press(actions)
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs)
	await action
	assert.equal(results.length, 1)
	assert.equal(results[0].success, false)
	assert.match(results[0].error, /callback budget/)
	assert.deepEqual(
		client.sent.map(({ cmd }) => cmd[0]),
		[0x21],
	)

	// The read stays on the wire to preserve legacy framing, but its eventual
	// result cannot publish state or authorize a write.
	read.resolve()
	await flush()
	assert.equal(results.length, 1, 'no late Last Action result is published')
	assert.deepEqual(
		client.sent.map(({ cmd }) => cmd[0]),
		[0x21],
	)

	await press(actions)
	assert.equal(results.at(-1).success, true, 'the channel lock recovers after the old read settles')
	assert.deepEqual(
		client.sent.map(({ cmd }) => cmd[0]),
		[0x21, 0x21, 0x01],
	)
})

test('a three-second gain read can still complete a fast write inside the host budget', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const socket = new FakeSocket()
	const tcp = new NewtonTcpClient('test', 6668, () => socket)
	t.after(() => tcp.destroy())
	tcp.connect()
	const results = []
	const actions = definitions(tcp, new GainMutationQueue(), results)
	const action = press(actions)
	t.mock.timers.tick(3000)
	socket.emit('data', preset)
	await flush()
	assert.deepEqual(
		socket.sent.map((cmd) => cmd[0]),
		[0x21, 0x01],
	)
	socket.emit('data', ack)
	await action
	assert.equal(results.at(-1).success, true)
})

test('a write waiting in the TCP queue is removed at the original action deadline', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const socket = new FakeSocket()
	const tcp = new NewtonTcpClient('test', 6668, () => socket)
	t.after(() => tcp.destroy())
	tcp.connect()
	const results = []
	const actions = definitions(tcp, new GainMutationQueue(), results)
	const action = press(actions)
	const blocker = tcp.sendCommandExpect(Buffer.from([0x90, 0]), { timeoutMs: 30000, queueTtlMs: 30000 })
	t.mock.timers.tick(1000)
	socket.emit('data', preset)
	await flush()
	assert.deepEqual(
		socket.sent.map((cmd) => cmd[0]),
		[0x21, 0x90],
	)
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs - 1000)
	await action
	assert.equal(results.at(-1).success, false)
	assert.match(results.at(-1).error, /callback budget/)
	socket.emit('data', ack)
	await blocker
	await flush()
	assert.equal(socket.sent.length, 2, 'the stale write is removed from the TCP queue')
})

test('the common action budget removes a queued snapshot before Companion times out', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const socket = new FakeSocket()
	const tcp = new NewtonTcpClient('test', 6668, () => socket)
	t.after(() => tcp.destroy())
	tcp.connect()
	const blocker = tcp.sendCommandExpect(Buffer.from([0x90, 0]), { timeoutMs: 30000, queueTtlMs: 30000 })
	const results = []
	const actions = getActionDefinitions(
		bindActionClient(tcp, SETTINGS.commandTimeoutMs, SETTINGS.actionQueueTtlMs),
		{ log() {}, reportActionResult: (result) => results.push(result) },
		new Map(),
		new Map(),
		[{ uuid: 'snapshot-1', name: 'Show' }],
		new Map(),
		() => false,
		() => true,
	)
	const action = actions.snapshot_apply_selected.callback({
		controlId: 'snapshot-button',
		options: { uuid: 'snapshot-1', fadingTime: 2000, mode: SnapshotApplyMode.Direct },
	})
	assert.equal(socket.sent.length, 1)
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs)
	await action
	assert.equal(results.length, 1)
	assert.match(results[0].error, /callback budget/)

	socket.emit('data', ack)
	await blocker
	await flush()
	assert.equal(socket.sent.length, 1, 'the expired snapshot command never reaches the wire')
	assert.equal(results.length, 1, 'the TCP queue rejection cannot replace the deadline result')
})

test('a rejected read releases the channel for the next gain/mute operation', async () => {
	let calls = 0
	const client = fakeClient()
	const send = client.sendCommandExpect.bind(client)
	client.sendCommandExpect = async (...args) => {
		if (++calls === 1) throw new Error('read failed')
		return send(...args)
	}
	const results = []
	const actions = definitions(client, new GainMutationQueue(), results)
	await Promise.all([press(actions), press(actions, 'set_channel_mute')])
	assert.deepEqual(
		results.map((result) => result.success),
		[false, true],
	)
	assert.deepEqual(
		client.sent.map(({ cmd }) => cmd[0]),
		[0x21, 0x01],
	)
})

for (const event of ['disconnected', 'stop', 'destroy']) {
	test(`session ${event} cancels queued gain/mute work and invalidates unfinished reads`, async (t) => {
		const socket = new FakeSocket()
		const originalConnect = NewtonTcpClient.prototype.connect
		t.mock.method(NewtonTcpClient.prototype, 'connect', function () {
			this.socketFactory = () => socket
			originalConnect.call(this)
		})
		const queue = new GainMutationQueue()
		const session = new NewtonSession({
			log() {},
			updateStatus() {},
			updateVariables() {},
			checkFeedbacks() {},
			updateVuVariables() {},
			publishVuVariablesNow() {},
			refreshDefinitions() {},
			hasGainSubscribers: () => false,
			cancelGainOperations: (reason) => queue.cancel(reason),
		})
		t.after(() => session.destroy())
		session.configure({ ...DEFAULT_CONFIG, host: 'test' })
		session.connectToDevice()
		const client = session.getClient()
		const results = []
		const actions = definitions(client, queue, results)
		const first = press(actions)
		const waiting = press(actions, 'set_gain')
		if (event === 'disconnected') client.emit('disconnected')
		else session[event]()
		await waiting
		assert.match(results[0].error, /cancelled/)
		if (event === 'disconnected') {
			// Even if this same client is usable again before the read settles,
			// its old transaction must not continue with a write.
			socket.emit('data', preset)
		}
		await first
		assert.equal(socket.sent.length, 1)
		assert.equal(results.length, 2)
		assert.ok(results.every((result) => !result.success))
	})
}

test('changing the instance target cancels old gain work without publishing its results on the new device', async (t) => {
	const sockets = []
	const originalConnect = NewtonTcpClient.prototype.connect
	t.mock.method(NewtonTcpClient.prototype, 'connect', function () {
		this.socketFactory = () => {
			const socket = new FakeSocket()
			sockets.push(socket)
			return socket
		}
		originalConnect.call(this)
	})
	// Exercise the real instance/session lifecycle without starting a UDP socket
	// or Companion IPC. Definition and variable publishing are captured below.
	t.mock.method(NewtonSession.prototype, 'startVuListener', () => {})
	class TestInstance extends NewtonInstance {
		definitions
		variables = {}
		log() {}
		updateStatus() {}
		setActionDefinitions(value) {
			this.definitions = value
		}
		setFeedbackDefinitions() {}
		setPresetDefinitions() {}
		saveConfig() {}
		setVariableDefinitions() {}
		setVariableValues(value) {
			Object.assign(this.variables, value)
		}
		checkFeedbacks() {}
	}
	const previousListeners = new Set(process.listeners('message'))
	const instance = new TestInstance({ _isInstanceBaseProps: true, id: 'queue-test', upgradeScripts: [] })
	t.after(async () => {
		await instance.destroy()
		for (const listener of process.listeners('message')) {
			if (!previousListeners.has(listener)) process.removeListener('message', listener)
		}
	})
	await instance.init({ ...DEFAULT_CONFIG, host: 'device-a' })
	const first = press(instance.definitions)
	const waiting = press(instance.definitions, 'set_gain')
	await instance.configUpdated({ ...DEFAULT_CONFIG, host: 'device-b' })
	await Promise.all([first, waiting])
	assert.equal(sockets[0].sent.length, 1)
	assert.equal(sockets[1].sent.length, 0)
	assert.equal(instance.variables.last_action_status, 'unknown')
	assert.equal(instance.variables.last_error, '')
	const fresh = press(instance.definitions, 'set_gain')
	assert.equal(sockets[1].sent.length, 1)
	sockets[1].emit('data', ack)
	await fresh
	assert.equal(instance.variables.last_action_status, 'success')
	assert.equal(sockets[0].sent.length, 1, 'cancelled work cannot resume on either target')
})

test('expired waiters free capacity while the active wire read keeps its channel locked', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const read = deferred()
	const client = fakeClient(read.promise)
	const results = []
	const actions = definitions(client, new GainMutationQueue(SETTINGS.actionCallbackBudgetMs, 2), results)
	const first = press(actions)
	const waiter = press(actions, 'set_channel_mute')
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs)
	await Promise.all([first, waiter])
	assert.equal(results.filter((result) => !result.success).length, 2)
	await press(actions, 'set_gain', 2)
	assert.equal(results.at(-1).success, true, 'another channel can use the freed waiter capacity')
	const next = press(actions, 'set_gain')
	assert.equal(client.sent.length, 2, 'same channel stays locked after expiry until its read settles')
	read.resolve()
	await next
	assert.equal(results.at(-1).success, true, 'queued work retains its own active execution context')
	assert.deepEqual(
		client.sent.map(({ cmd }) => cmd[0]),
		[0x21, 0x01, 0x01],
	)
})

test('an unconfirmed write retains the wire lock but its late ACK cannot publish success', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const socket = new FakeSocket()
	const tcp = new NewtonTcpClient('test', 6668, () => socket)
	t.after(() => tcp.destroy())
	tcp.connect()
	const results = []
	const actions = definitions(tcp, new GainMutationQueue(), results)
	const first = press(actions)
	t.mock.timers.tick(3000)
	socket.emit('data', preset)
	await flush()
	assert.equal(socket.sent.length, 2)
	t.mock.timers.tick(1500)
	await first
	assert.equal(results.length, 1)
	assert.match(results[0].error, /completion is not confirmed/)
	const next = press(actions, 'set_gain')
	assert.equal(socket.sent.length, 2, 'do not release the active write at the callback deadline')
	t.mock.timers.tick(500)
	socket.emit('data', ack)
	await flush()
	assert.equal(results.length, 1, 'late write ACK cannot replace the expired outcome')
	assert.equal(socket.sent.length, 3, 'fresh operation starts only after the old response is drained')
	socket.emit('data', ack)
	await next
	assert.deepEqual(
		results.map((result) => result.success),
		[false, true],
	)
	assert.equal(tcp.isConnected, true)
})
