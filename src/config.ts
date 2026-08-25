import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

/** Operator-editable connection settings. */
export interface ModuleConfig {
	host: string
	meter_poll_interval: number
	gain_mute_poll_interval: number
}

// UDP 0x2B meter/status query interval. The ceiling stays at 1000 ms: the VU
// listener declares the stream lost after 3000 ms, so a slower cadence would
// let a single dropped reply produce a false expiry before the next query.
export const METER_POLL_INTERVAL_DEFAULT = 100
export const METER_POLL_INTERVAL_MIN = 80
export const METER_POLL_INTERVAL_MAX = 1000

// TCP 0x21 full audio-preset reread interval (~384 KiB per response) that
// refreshes gain/mute state while such feedbacks are subscribed.
export const GAIN_MUTE_POLL_INTERVAL_DEFAULT = 1500
export const GAIN_MUTE_POLL_INTERVAL_MIN = 1000
export const GAIN_MUTE_POLL_INTERVAL_MAX = 5000

export const DEFAULT_CONFIG: ModuleConfig = {
	host: '',
	meter_poll_interval: METER_POLL_INTERVAL_DEFAULT,
	gain_mute_poll_interval: GAIN_MUTE_POLL_INTERVAL_DEFAULT,
}

/**
 * One normalization for init, configUpdated and every interval consumer. The
 * UI min/max are advisory only: imported or hand-edited configs can carry
 * missing, non-numeric or out-of-range values, and a non-finite interval must
 * never reach a setInterval call.
 */
export function normalizeConfig(config: Partial<ModuleConfig> | undefined | null): ModuleConfig {
	return {
		host: typeof config?.host === 'string' ? config.host : '',
		meter_poll_interval: normalizeIntervalMs(
			config?.meter_poll_interval,
			METER_POLL_INTERVAL_DEFAULT,
			METER_POLL_INTERVAL_MIN,
			METER_POLL_INTERVAL_MAX,
		),
		gain_mute_poll_interval: normalizeIntervalMs(
			config?.gain_mute_poll_interval,
			GAIN_MUTE_POLL_INTERVAL_DEFAULT,
			GAIN_MUTE_POLL_INTERVAL_MIN,
			GAIN_MUTE_POLL_INTERVAL_MAX,
		),
	}
}

function normalizeIntervalMs(value: unknown, fallback: number, min: number, max: number): number {
	const num =
		typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
	if (!Number.isFinite(num)) return fallback
	return Math.min(max, Math.max(min, Math.round(num)))
}

export interface ConfigChanges {
	targetChanged: boolean
	meterChanged: boolean
	gainMuteChanged: boolean
}

/**
 * Which subsystems a config save touches. Each interval restarts only what it
 * governs: the host tears down the whole session, the meter interval recreates
 * only the UDP listener, the gain/mute interval restarts only the 0x21 timer.
 */
export function diffConfig(current: ModuleConfig, next: ModuleConfig): ConfigChanges {
	return {
		targetChanged: current.host !== next.host,
		meterChanged: current.meter_poll_interval !== next.meter_poll_interval,
		gainMuteChanged: current.gain_mute_poll_interval !== next.gain_mute_poll_interval,
	}
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Device IP Address',
			width: 12,
			regex: Regex.IP,
			required: true,
		},
		{
			type: 'number',
			id: 'meter_poll_interval',
			label: 'Meter/status polling interval (ms)',
			tooltip:
				'How often to query VU meters, priority and clock status over UDP 6667. 100 ms = 10 queries/s. Lower = smoother meters, more network traffic.',
			width: 6,
			default: METER_POLL_INTERVAL_DEFAULT,
			min: METER_POLL_INTERVAL_MIN,
			max: METER_POLL_INTERVAL_MAX,
		},
		{
			type: 'number',
			id: 'gain_mute_poll_interval',
			label: 'Gain/Mute refresh interval (ms)',
			tooltip:
				'How often to reread gain/mute state with the full TCP 0x21 preset (~384 KiB). 1500 ms = one read every 1.5 s. Only active while gain/mute feedbacks are in use.',
			width: 6,
			default: GAIN_MUTE_POLL_INTERVAL_DEFAULT,
			min: GAIN_MUTE_POLL_INTERVAL_MIN,
			max: GAIN_MUTE_POLL_INTERVAL_MAX,
		},
	]
}
