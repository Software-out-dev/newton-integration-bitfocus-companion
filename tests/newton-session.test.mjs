/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DEFAULT_CONFIG } from '../dist/config.js'
import { NewtonSession } from '../dist/newton-session.js'
import { NewtonTcpClient } from '../dist/protocol/tcp-client.js'
import { SETTINGS } from '../dist/settings.js'

async function flush() {
	for (let i = 0; i < 30; i++) await Promise.resolve()
}

function legacyReply(length, text = '') {
	const reply = Buffer.alloc(length)
	reply[0] = 0x33
	reply.write(text, 2, 'ascii')
	return reply
}

const REPLIES = {
	0x3e: legacyReply(18, 'Newton'),
	0x40: legacyReply(10, '0.97'),
	0x37: legacyReply(18, 'SN-1'),
	0x91: Buffer.from([1, 2, 3, 4, 0, 0]),
	0x81: Buffer.alloc(19),
}

// Identity replies stay under the 3 s command timeout but slow enough that
// the connect-time identity cycle (0x3E → 0x40 → 0x37) is still in flight
// when the 5 s identity interval fires for the first time.
const SLOW_REPLY_MS = { 0x3e: 2500, 0x40: 2500 }

class SlowIdentitySocket extends EventEmitter {
	isConnected = true
	sent = []
	send(cmd) {
		this.sent.push(cmd)
		const reply = REPLIES[cmd[0]]
		if (reply) {
			const delayMs = SLOW_REPLY_MS[cmd[0]]
			if (delayMs) setTimeout(() => this.emit('data', reply), delayMs)
			else queueMicrotask(() => this.emit('data', reply))
		}
		return Promise.resolve(true)
	}
	destroy() {
		this.isConnected = false
	}
}

test('connect-time polls stay single-flight until their first cycle settles', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
	const socket = new SlowIdentitySocket()
	const originalConnect = NewtonTcpClient.prototype.connect
	t.mock.method(NewtonTcpClient.prototype, 'connect', function () {
		this.socketFactory = () => socket
		originalConnect.call(this)
	})
	// No UDP socket in a unit test; the identity and metadata schedulers are the subject.
	t.mock.method(NewtonSession.prototype, 'startVuListener', () => {})
	const session = new NewtonSession({
		log() {},
		updateStatus() {},
		updateVariables() {},
		checkFeedbacks() {},
		updateVuVariables() {},
		publishVuVariablesNow() {},
		refreshDefinitions() {},
		hasGainSubscribers: () => false,
		cancelGainOperations() {},
	})
	t.after(() => session.destroy())
	session.configure({ ...DEFAULT_CONFIG, host: 'test' })
	session.connectToDevice()

	// Count requests as the session issues them, not as they reach the wire:
	// a duplicate cycle would sit in the serialized TCP queue behind the slow reads.
	const requests = []
	const client = session.getClient()
	const send = client.sendCommandExpect.bind(client)
	client.sendCommandExpect = (cmd, options) => {
		requests.push(cmd[0])
		return send(cmd, options)
	}
	const count = (id) => requests.filter((cmd) => cmd === id).length

	socket.emit('connect')
	await flush()
	assert.equal(count(0x3e), 1, 'the identity cycle starts with one description read')
	assert.equal(count(0x91), 1, 'the metadata cycle starts with one priority list read')

	// Two metadata ticks pass while the first 0x91/0x81 cycle still waits behind the identity reads.
	t.mock.timers.tick(2 * SETTINGS.priorityMetadataPollInterval)
	await flush()
	assert.equal(count(0x91), 1, 'the metadata poller must not start a second cycle while one is in flight')

	// The identity interval fires while the first identity cycle is still reading the firmware version.
	t.mock.timers.tick(SETTINGS.pollInterval - 2 * SETTINGS.priorityMetadataPollInterval)
	await flush()
	assert.equal(count(0x3e), 1, 'the identity poller must not start a second cycle while one is in flight')
})
