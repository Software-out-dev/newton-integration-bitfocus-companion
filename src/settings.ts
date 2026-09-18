import { PORT_METERS, PORT_TCP } from './protocol/constants.js'

/** Fixed runtime settings, not exposed in the connection config UI. */
export interface ModuleSettings {
	port: number
	pollInterval: number
	priorityMetadataPollInterval: number
	commandTimeoutMs: number
	presetAudioTimeoutMs: number
	actionCallbackBudgetMs: number
	actionQueueTtlMs: number
	snapshotDbRetryMs: number
	vuPort: number
}

// Keep command failure visible promptly and release the serialized control
// queue; 3 seconds is the agreed response deadline for Newton control.
const COMMAND_TIMEOUT_MS = 3000
// The 0x21 full audio-preset response is roughly 384 KiB. It may need
// longer than an interactive command on a busy Newton, but stays bounded.
const PRESET_AUDIO_TIMEOUT_MS = 12000
// Companion API 1.12 gives an action callback 5 seconds. Finish or reject
// operator mutations before that boundary, leaving a margin for IPC delivery.
// A read already on the wire may keep its longer framing timeout, but it must
// not be allowed to start a later write after this budget expires.
const ACTION_CALLBACK_BUDGET_MS = 4500
// Transport fallback for callers without a shorter execution deadline.
// Action callbacks always cap this TTL to their remaining 4.5-second budget;
// background full-preset transfers retain their independent wire timeout.
const ACTION_QUEUE_TTL_MS = PRESET_AUDIO_TIMEOUT_MS + COMMAND_TIMEOUT_MS + 1000

export const SETTINGS: ModuleSettings = {
	port: PORT_TCP,
	pollInterval: 5000,
	priorityMetadataPollInterval: 1000,
	commandTimeoutMs: COMMAND_TIMEOUT_MS,
	presetAudioTimeoutMs: PRESET_AUDIO_TIMEOUT_MS,
	actionCallbackBudgetMs: ACTION_CALLBACK_BUDGET_MS,
	actionQueueTtlMs: ACTION_QUEUE_TTL_MS,
	// A connect-time snapshot database read that expired behind a long preset
	// transfer is retried on this cadence until it lands.
	snapshotDbRetryMs: 5000,
	vuPort: PORT_METERS,
}
