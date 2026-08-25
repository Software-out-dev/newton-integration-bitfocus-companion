import {
	CLOCK_TYPE_COUNT,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
} from './protocol/constants.js'
import type { NewtonState } from './protocol/types.js'

/**
 * Fresh all-unknown device state. Single source of truth for variables and
 * feedbacks: protocol handlers update this object first, then publish the
 * small subset Companion needs.
 */
export function createInitialNewtonState(): NewtonState {
	return {
		connected: false,
		deviceName: '',
		firmwareVersion: '',
		serialNumber: '',
		lastError: '',
		lastCommand: '',
		lastResponseHex: '',
		lastActionName: '',
		lastActionStatus: 'unknown',
		lastActionResponseHex: '',
		lastActionResults: new Map(),
		lastPriorityUpdate: '',
		lastVuUpdate: '',
		snapshotCount: 0,
		lastSnapshotResponse: '',
		lastAppliedSnapshot: '',
		priorityInputDsp: new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(-1),
		priorityAuxMixer: new Array(SIGNALS_AUX_MIXER_PRIORITY_COUNT).fill(-1),
		priorityLists: new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(null),
		priorityListsUnsupported: false,
		vuInputDsp: [],
		vuOutputDsp: [],
		vuInputDspRms: [],
		vuOutputDspRms: [],
		gainReads: new Map(),
		clockSelected: new Array(CLOCK_TYPE_COUNT).fill(-1),
		clockLists: new Array(CLOCK_TYPE_COUNT).fill(null),
		clockListsUnsupported: false,
		snapshotList: [],
		snapshotDatabaseLoaded: false,
		snapshotsUnsupported: false,
		vu: {
			rawLength: 0,
			rawFirstHex: '',
			format: 'No VU packets',
		},
	}
}

export function arraysEqual(a: number[], b: number[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
