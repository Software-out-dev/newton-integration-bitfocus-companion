/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import test from 'node:test'
import { IpcWrapper } from '@companion-module/base/dist/host-api/ipc-wrapper.js'
import { ActionManager } from '@companion-module/base/dist/internal/actions.js'
import { getActionDefinitions } from '../dist/actions.js'
import { ChannelType } from '../dist/protocol/constants.js'
import { PRESET_AUDIO_RESPONSE_LENGTH } from '../dist/protocol/command-parser.js'
import { SETTINGS } from '../dist/settings.js'

const flush = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}

function deferred() {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}

test('real Companion action IPC completes before its 5s timeout without a late gain write', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const read = deferred()
	const sent = [],
		outcomes = [],
		publications = []
	const preset = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
	preset[0] = 0x33
	preset.writeFloatLE(-6, 1010)
	const actions = getActionDefinitions(
		{
			async sendCommandExpect(cmd, options) {
				sent.push(cmd[0])
				await read.promise
				return { success: true, rx: preset, parsed: options.parser?.(preset) }
			},
		},
		{
			log() {},
			reportActionResult: (result) => outcomes.push(result),
			reportGainRead: (...args) => publications.push(args),
		},
	)
	const manager = new ActionManager(
		async () => ({ text: '' }),
		() => {},
		() => {},
		(_, message) => assert.fail(message),
	)
	manager.setActionDefinitions(actions)
	let host, module
	host = new IpcWrapper({}, (message) => module.receivedMessage(message), 5000)
	module = new IpcWrapper(
		{ executeAction: (message) => manager.handleExecuteAction(message) },
		(message) => host.receivedMessage(message),
		5000,
	)
	let hostCompleted = false
	const result = host
		.sendWithCb('executeAction', {
			action: {
				id: 'press',
				controlId: 'button',
				actionId: 'adjust_gain',
				options: { channelType: ChannelType.InputDsp, channel: 1, direction: 'up', deltaDb: 1 },
			},
		})
		.then(() => {
			hostCompleted = true
		})
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs)
	await flush()
	assert.equal(hostCompleted, true, 'host must receive completion before its own timer fires')
	await result
	assert.equal(outcomes.length, 1)
	assert.equal(outcomes[0].success, false)
	t.mock.timers.tick(800)
	read.resolve()
	await flush()
	assert.deepEqual(sent, [0x21])
	assert.equal(outcomes.length, 1)
	assert.deepEqual(publications, [])
})

test('rearm-all cannot continue with another input or write after its action expires', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const read = deferred()
	const sent = [],
		outcomes = []
	const actions = getActionDefinitions(
		{
			async sendCommandExpect(cmd) {
				sent.push(cmd)
				await read.promise
				return { success: true, rx: Buffer.from([0x33, 0, 1, 2, 3, 4]), parsed: { sources: [1, 2, 3, 4] } }
			},
		},
		{ log() {}, reportActionResult: (result) => outcomes.push(result) },
	)
	const action = actions.rearm_all_inputs.callback({ controlId: 'all', options: {} })
	t.mock.timers.tick(SETTINGS.actionCallbackBudgetMs)
	await action
	assert.equal(outcomes.length, 1)
	assert.equal(outcomes[0].success, false)
	read.resolve()
	await flush()
	assert.equal(sent.length, 1, 'neither a late write nor reads for remaining inputs may be sent')
	assert.equal(outcomes.length, 1)
})

test('completion arriving at the deadline publishes exactly one failure even before the timer callback', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const reply = deferred()
	const outcomes = []
	const actions = getActionDefinitions(
		{
			async sendCommandExpect() {
				await reply.promise
				return { success: true, rx: Buffer.from([0x33, 0]), parsed: null }
			},
		},
		{ log() {}, reportActionResult: (result) => outcomes.push(result) },
	)
	const action = actions.set_gain.callback({
		controlId: 'button',
		options: {
			channelType: ChannelType.InputDsp,
			channelIndex: 1,
			gainDb: -6,
			mute: false,
		},
	})
	// Advance the clock without running timers: model an I/O completion whose
	// microtasks run before the due timeout callbacks.
	t.mock.timers.setTime(1000 + SETTINGS.actionCallbackBudgetMs)
	reply.resolve()
	await action
	assert.equal(outcomes.length, 1)
	assert.equal(outcomes[0].success, false)
	assert.match(outcomes[0].error, /callback budget/)
	t.mock.timers.tick(1000)
	await flush()
	assert.equal(outcomes.length, 1, 'a subsequently dispatched timeout must not duplicate the outcome')
})
