import type { ChannelType, SnapshotApplyMode } from './constants.js'

/** Result of parsing a legacy protocol response */
export interface LegacyResponse {
	success: boolean
	payload: Buffer
}

/** Result of parsing an SPR (Special Protocol Reply) */
export interface SPRResponse {
	command: number
	success: boolean
	payload: Record<string, unknown> | null
}

export interface PriorityListState {
	sources: number[]
	isForced: boolean
	forcedChannel: number
}

/** Result of a Get Gain (0x01) read: gain in dB plus the mute flag. */
export interface GainReadState {
	gainDb: number
	muted: boolean
}

/** One snapshot entry from the device database (Get Database 0x0003). */
export interface SnapshotInfo {
	uuid: string
	/** Operator-facing name (falls back to description or short uuid). */
	name: string
}

/** Result of a Get Processing Clock (0x81) read. */
export interface ClockPriorityState {
	/** 16 Clock List values, highest priority first. */
	list: number[]
	isForced: boolean
	/** Index into `list` of the forced clock (meaningful when isForced). */
	forcedIndex: number
	/** True when the clock runs at 48 kHz instead of 96 kHz. */
	is48: boolean
}

export interface VuState {
	/** Stream status shown to operators: the decoded format, or the loss reason. */
	format: string
}

export type NewtonActionStatus = 'unknown' | 'success' | 'error'

export interface NewtonActionResult {
	name: string
	success: boolean
	responseHex: string
	error?: string
	/** Companion control that triggered the action, when invoked from a button. */
	controlId?: string
}

/** Gain command parameters */
export interface GainParams {
	channelType: ChannelType
	channelIndex: number
	gainDb: number
	mute: boolean
}

/** Snapshot apply parameters */
export interface SnapshotApplyParams {
	uuid: string
	fadingTime?: number
	mode?: SnapshotApplyMode
}

/** Device state tracked by the module */
export interface NewtonState {
	connected: boolean
	deviceName: string
	firmwareVersion: string
	serialNumber: string
	lastError: string
	lastCommand: string
	lastResponseHex: string
	lastActionName: string
	lastActionStatus: NewtonActionStatus
	lastActionResponseHex: string
	/** Latest result per Companion control, so buttons do not overwrite each other's feedback color. */
	lastActionResults: Map<string, NewtonActionResult>
	lastPriorityUpdate: string
	lastVuUpdate: string
	snapshotCount: number
	lastSnapshotResponse: string
	lastAppliedSnapshot: string
	/** Active source channel for InputDsp priority patches (0..15). -1 = unknown. */
	priorityInputDsp: number[]
	/** Active source channel for AuxMixer priority patches (0..7). -1 = unknown. */
	priorityAuxMixer: number[]
	/**
	 * H2L channel list per Input DSP patch (protocol index 0..15), polled via
	 * 0x91 round-robin. sources[0] is the healthy first-priority source; null
	 * until read.
	 */
	priorityLists: (PriorityListState | null)[]
	/** True once the firmware rejected 0x91; list polling stops until reconnect. */
	priorityListsUnsupported: boolean
	/** Latest peak VU levels for InputDsp channels (per-channel dB). */
	vuInputDsp: number[]
	/** Latest peak VU levels for OutputDsp channels (per-channel dB). */
	vuOutputDsp: number[]
	/** Latest RMS VU levels for InputDsp channels (per-channel dB). */
	vuInputDspRms: number[]
	/** Latest RMS VU levels for OutputDsp channels (per-channel dB). */
	vuOutputDspRms: number[]
	vu: VuState
	/**
	 * Latest gain/mute state from the preset-audio read, keyed by
	 * `${channelType}:${channelIndex}`. Absent until the first refresh.
	 */
	gainReads: Map<string, GainReadState>
	/**
	 * Definitive clock source (Clock List value) per clock type
	 * [Master, WC Out 1, WC Out 2], from 0x2B bytes 631/648/665. -1 = unknown.
	 */
	clockSelected: number[]
	/** 0x81 clock priority state per clock type, null until read. */
	clockLists: (ClockPriorityState | null)[]
	/** True once the firmware rejected 0x81; clock polling stops until reconnect. */
	clockListsUnsupported: boolean
	/** Snapshot database entries read from the device, in device order. */
	snapshotList: SnapshotInfo[]
	/** True after a valid snapshot database response, including an empty list. */
	snapshotDatabaseLoaded: boolean
	/**
	 * True once snapshots were ruled out: firmware < 0.98, or the device
	 * rejected the snapshot database read. Cleared on reconnect.
	 */
	snapshotsUnsupported: boolean
}
