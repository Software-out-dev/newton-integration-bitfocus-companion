/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionManager } from '@companion-module/base/dist/internal/actions.js'
import { NewtonInstance } from '../dist/instance.js'

// Exercise Companion's real action lifecycle, including edits, disabled
// actions and definition refreshes, without connecting to any device.
test('snapshot preset label follows the action selection through Companion lifecycle updates', async (t) => {
	class TestInstance extends NewtonInstance {
		feedbacks = {}
		presets = {}
		checks = []
		manager = new ActionManager(
			async () => ({ text: '' }),
			() => {},
			() => {},
			(level, message) => assert.fail(`${level}: ${message}`),
		)
		log() {}
		updateStatus() {}
		saveConfig() {}
		setVariableDefinitions() {}
		setVariableValues() {}
		setActionDefinitions(definitions) {
			this.manager.setActionDefinitions(definitions)
		}
		setFeedbackDefinitions(definitions) {
			this.feedbacks = definitions
		}
		setPresetDefinitions(definitions) {
			this.presets = definitions
		}
		checkFeedbacks(...ids) {
			this.checks.push(...ids)
		}
	}
	const listeners = new Set(process.listeners('message'))
	const instance = new TestInstance({ _isInstanceBaseProps: true, id: 'snapshot-label-test', upgradeScripts: [] })
	t.after(async () => {
		await instance.destroy()
		for (const listener of process.listeners('message')) {
			if (!listeners.has(listener)) process.removeListener('message', listener)
		}
	})
	await instance.init({ host: '' })
	const state = instance.session.getState()
	state.snapshotDatabaseLoaded = true
	state.snapshotList = [
		{ uuid: 'a', name: 'Show A' },
		{ uuid: 'b', name: 'Show B' },
	]
	instance.setupDefinitions()
	const preset = instance.presets.snapshot_apply
	assert.equal(preset.style.text, 'APPLY\nSNAP\nSHOT')
	assert.deepEqual(preset.feedbacks, [{ feedbackId: 'snapshot_action_label', options: {} }])
	assert.deepEqual(instance.feedbacks.snapshot_action_label.options, [])
	const label = (controlId = 'button') =>
		instance.feedbacks.snapshot_action_label.callback({ controlId, options: {} }).text
	const action = (id, uuid, controlId = 'button', disabled = false) => ({
		id,
		actionId: 'snapshot_apply_selected',
		controlId,
		disabled,
		options: { uuid, fadingTime: 2000, mode: 'Direct' },
	})
	const update = (id, value) => {
		instance.checks.length = 0
		instance.manager.handleUpdateActions({ [id]: value })
		assert.ok(instance.checks.includes('snapshot_action_label'), 'selection changes must request a redraw')
	}
	assert.equal(label(), 'APPLY\nSNAP\nSHOT')
	update('first', action('first', ''))
	assert.equal(label(), 'APPLY\nSNAP\nSHOT')
	update('first', action('first', 'a'))
	assert.equal(label(), 'APPLY\nShow A', 'updates without executing a recall')
	update('first', action('first', 'b'))
	assert.equal(label(), 'APPLY\nShow B')
	assert.equal(label('other'), 'APPLY\nSNAP\nSHOT')

	state.snapshotList = [
		{ uuid: 'a', name: 'Renamed A' },
		{ uuid: 'b', name: 'Renamed B' },
	]
	instance.setupDefinitions()
	assert.equal(label(), 'APPLY\nRenamed B', 'definitions may refresh without action resubscription')
	state.snapshotDatabaseLoaded = false
	assert.equal(label(), 'SNAPSHOT\nLOADING…')
	state.snapshotDatabaseLoaded = true
	state.snapshotList = []
	assert.equal(label(), 'SNAPSHOT\nMISSING')
	state.snapshotsUnsupported = true
	assert.match(label(), /^NO SNAPSHOT\nFW </)
	state.snapshotsUnsupported = false
	state.snapshotList = [
		{ uuid: 'a', name: 'Show A' },
		{ uuid: 'b', name: 'Show B' },
	]

	update('second', action('second', 'b'))
	assert.equal(label(), 'APPLY\nShow B')
	update('first', null)
	assert.equal(label(), 'APPLY\nShow B', 'removing one action must preserve its sibling')
	update('first', action('first', 'a'))
	assert.equal(label(), 'APPLY\nMULTIPLE', 'do not mislabel multiple different recalls')
	update('first', action('first', 'a', 'button', true))
	assert.equal(label(), 'APPLY\nShow B', 'disabled actions do not affect the label')
	update('second', action('second', 'b', 'other'))
	assert.equal(label(), 'APPLY\nSNAP\nSHOT')
	assert.equal(label('other'), 'APPLY\nShow B')
	update('second', null)
	assert.equal(label('other'), 'APPLY\nSNAP\nSHOT')
})
