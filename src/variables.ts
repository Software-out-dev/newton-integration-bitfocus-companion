import type { CompanionVariableDefinition } from '@companion-module/base'
import {
	PRIORITY_SOURCE_NONE,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
} from './protocol/constants.js'
import type { NewtonState } from './protocol/types.js'

const VU_INPUT_CHANNELS = 16
const VU_OUTPUT_CHANNELS = 16

/** Convert Newton's zero-based source index to the operator-facing number. */
export function prioritySourceForOperator(value: number | undefined): number | 'N/A' {
	return value !== undefined && Number.isInteger(value) && value >= 0 && value < PRIORITY_SOURCE_NONE
		? value + 1
		: 'N/A'
}

export function getVariableDefinitions(): CompanionVariableDefinition[] {
	const defs: CompanionVariableDefinition[] = [
		{ variableId: 'connection_state', name: 'Connection State' },
		{ variableId: 'device_name', name: 'Device Name/Description' },
		{ variableId: 'firmware_version', name: 'Firmware Version' },
		{ variableId: 'serial_number', name: 'Serial Number' },
		{ variableId: 'last_error', name: 'Last Error' },
		{ variableId: 'last_command', name: 'Last Command' },
		{ variableId: 'last_response_hex', name: 'Last Response Hex' },
		{ variableId: 'last_action_name', name: 'Last Action Name' },
		{ variableId: 'last_action_status', name: 'Last Action Status' },
		{ variableId: 'last_action_response_hex', name: 'Last Action Response Hex' },
		{ variableId: 'last_priority_update', name: 'Last Priority Update' },
		{ variableId: 'last_vu_update', name: 'Last VU Update' },
		{ variableId: 'snapshot_count', name: 'Snapshot Count' },
		{ variableId: 'snapshot_support', name: 'Snapshot Support' },
		{ variableId: 'last_snapshot_response', name: 'Last Snapshot Response' },
		{ variableId: 'last_applied_snapshot', name: 'Last Applied Snapshot' },
		{ variableId: 'vu_format', name: 'VU Stream Status' },
	]

	// Per-channel variables use 1-based operator-facing numbering.
	for (let i = 0; i < SIGNALS_INPUT_DSP_PRIORITY_COUNT; i++) {
		defs.push({
			variableId: `priority_input_${i + 1}`,
			name: `Priority Patch Input DSP ${i + 1} - Active Source`,
		})
	}
	for (let i = 0; i < SIGNALS_AUX_MIXER_PRIORITY_COUNT; i++) {
		defs.push({
			variableId: `priority_aux_input_${i + 1}`,
			name: `Priority Patch Aux Mixer ${i + 1} - Active Source`,
		})
	}
	for (let i = 0; i < VU_INPUT_CHANNELS; i++) {
		defs.push({ variableId: `vu_input_${i + 1}`, name: `VU Input DSP ${i + 1}` })
	}
	for (let i = 0; i < VU_OUTPUT_CHANNELS; i++) {
		defs.push({ variableId: `vu_output_${i + 1}`, name: `VU Output DSP ${i + 1}` })
	}

	return defs
}

/** Every non-per-channel-VU variable value, derived from the device state. */
export function buildDeviceVariables(state: NewtonState): Record<string, string | number | undefined> {
	const vars: Record<string, string | number | undefined> = {
		connection_state: state.connected ? 'Connected' : 'Disconnected',
		device_name: state.deviceName || 'Unknown',
		firmware_version: state.firmwareVersion || 'Unknown',
		serial_number: state.serialNumber || 'Unknown',
		last_error: state.lastError || '',
		last_command: state.lastCommand || '',
		last_response_hex: state.lastResponseHex || '',
		last_action_name: state.lastActionName || '',
		last_action_status: state.lastActionStatus,
		last_action_response_hex: state.lastActionResponseHex || '',
		last_priority_update: state.lastPriorityUpdate || 'Never',
		last_vu_update: state.lastVuUpdate || 'Never',
		snapshot_count: state.snapshotCount,
		last_snapshot_response: state.lastSnapshotResponse || '',
		last_applied_snapshot: state.lastAppliedSnapshot || '',
	}

	for (let i = 0; i < SIGNALS_INPUT_DSP_PRIORITY_COUNT; i++) {
		vars[`priority_input_${i + 1}`] = prioritySourceForOperator(state.priorityInputDsp[i])
	}
	for (let i = 0; i < SIGNALS_AUX_MIXER_PRIORITY_COUNT; i++) {
		vars[`priority_aux_input_${i + 1}`] = prioritySourceForOperator(state.priorityAuxMixer[i])
	}

	vars.snapshot_support = state.snapshotsUnsupported
		? 'Unsupported by firmware'
		: state.snapshotDatabaseLoaded
			? 'OK'
			: 'Unknown'

	vars.vu_format = state.vu.format

	return vars
}

/** Per-channel VU variable values plus the VU stream status. */
export function buildVuVariables(state: NewtonState): Record<string, string | number> {
	const vars: Record<string, string | number> = {}
	if (state.vuInputDsp.length === 0 && state.vuOutputDsp.length === 0) {
		// Unknown/undecoded packet format: publish N/A rather than leaving the
		// last-known per-channel values frozen on screen.
		for (let i = 0; i < VU_INPUT_CHANNELS; i++) {
			vars[`vu_input_${i + 1}`] = 'N/A'
		}
		for (let i = 0; i < VU_OUTPUT_CHANNELS; i++) {
			vars[`vu_output_${i + 1}`] = 'N/A'
		}
	} else {
		for (let i = 0; i < VU_INPUT_CHANNELS; i++) {
			vars[`vu_input_${i + 1}`] = state.vuInputDsp[i]?.toFixed(2) ?? 'N/A'
		}
		for (let i = 0; i < VU_OUTPUT_CHANNELS; i++) {
			vars[`vu_output_${i + 1}`] = state.vuOutputDsp[i]?.toFixed(2) ?? 'N/A'
		}
	}
	vars.vu_format = state.vu.format
	vars.last_vu_update = state.lastVuUpdate || 'Never'
	return vars
}
