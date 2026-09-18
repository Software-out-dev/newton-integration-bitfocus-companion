/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NewtonInstance } from '../dist/instance.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../dist/config.js'
import { getPresetDefinitions } from '../dist/presets.js'
import { getActionDefinitions } from '../dist/actions.js'
import { getFeedbackDefinitions } from '../dist/feedbacks.js'
import { createInitialNewtonState } from '../dist/state.js'

test('existing connections persist missing or zero intervals and preserve valid operator choices', async (t) => {
	class TestInstance extends NewtonInstance {
		saved = []
		presets = {}
		log() {}
		updateStatus() {}
		setActionDefinitions() {}
		setFeedbackDefinitions() {}
		setVariableDefinitions() {}
		setVariableValues() {}
		checkFeedbacks() {}
		setPresetDefinitions(presets) {
			this.presets = presets
		}
		saveConfig(config) {
			this.saved.push(config)
		}
	}
	const existingListeners = new Set(process.listeners('message'))
	const instance = new TestInstance({ _isInstanceBaseProps: true, id: 'config-test', upgradeScripts: [] })
	t.after(async () => {
		await instance.destroy()
		for (const listener of process.listeners('message')) {
			if (!existingListeners.has(listener)) process.removeListener('message', listener)
		}
	})
	await instance.init({ host: '' })
	assert.deepEqual(instance.saved, [{ host: '', meter_poll_interval: 80, gain_mute_poll_interval: 1500 }])
	assert.equal(Object.keys(instance.presets).length, 12, 'presets are registered by the real instance')
	// Even when the effective runtime values do not change, the UI must be
	// repaired before configUpdated takes its no-restart early return.
	await instance.configUpdated({ host: '', meter_poll_interval: 0, gain_mute_poll_interval: 0 })
	assert.equal(instance.saved.length, 2)
	assert.deepEqual(instance.saved.at(-1), DEFAULT_CONFIG)
	await instance.configUpdated({ host: '', meter_poll_interval: 50, gain_mute_poll_interval: 2200 })
	assert.equal(instance.saved.length, 2, 'valid user choices are not replaced with defaults')
	assert.deepEqual(normalizeConfig({ meter_poll_interval: '0', gain_mute_poll_interval: -1 }), DEFAULT_CONFIG)
})

test('all restored presets reference existing actions and feedbacks with valid default selections', () => {
	const presets = getPresetDefinitions()
	const actions = getActionDefinitions(null, { log() {} })
	const feedbacks = getFeedbackDefinitions(() => createInitialNewtonState())
	assert.deepEqual(Object.keys(presets).sort(), [
		'channel_gain',
		'channel_mute',
		'clock_monitor',
		'clock_rearm',
		'connection',
		'level_down',
		'level_up',
		'meter',
		'priority_input_monitor',
		'priority_input_rearm',
		'priority_rearm_all',
		'snapshot_apply',
	])
	const validateOptions = (item, definition) => {
		for (const [key, value] of Object.entries(item.options)) {
			const option = definition.options.find((entry) => entry.id === key)
			assert.ok(option, `unknown option ${key}`)
			if (option.type === 'dropdown') assert.ok(option.choices.some((choice) => choice.id === value))
			if (option.type === 'number') assert.ok(value >= option.min && value <= option.max)
		}
	}
	for (const preset of Object.values(presets)) {
		assert.ok(!preset.style.text.includes('\\n'), 'button text must use actual newlines')
		for (const step of preset.steps) {
			for (const item of [...step.down, ...step.up]) {
				assert.ok(actions[item.actionId], `missing action ${item.actionId}`)
				validateOptions(item, actions[item.actionId])
			}
		}
		for (const item of preset.feedbacks) {
			assert.ok(feedbacks[item.feedbackId], `missing feedback ${item.feedbackId}`)
			validateOptions(item, feedbacks[item.feedbackId])
		}
	}
})
