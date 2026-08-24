import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type Interactivity = 'low' | 'medium' | 'high'

export interface InteractivityProfile {
	meterPollInterval: number
	presetAudioPollInterval: number
}

/** Operator profiles affect UDP meters and the large TCP audio-preset refresh only. */
export const INTERACTIVITY_PROFILES: Readonly<Record<Interactivity, InteractivityProfile>> = {
	low: { meterPollInterval: 1000, presetAudioPollInterval: 5000 },
	medium: { meterPollInterval: 200, presetAudioPollInterval: 2000 },
	high: { meterPollInterval: 80, presetAudioPollInterval: 1000 },
}

export function normalizeInteractivity(value: unknown): Interactivity {
	return value === 'low' || value === 'high' || value === 'medium' ? value : 'medium'
}

export function getInteractivityProfile(value: unknown): InteractivityProfile {
	return INTERACTIVITY_PROFILES[normalizeInteractivity(value)]
}

/** Operator-editable connection and response profile settings. */
export interface ModuleConfig {
	host: string
	interactivity: Interactivity
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
			type: 'dropdown',
			id: 'interactivity',
			label: 'Interactivity',
			width: 6,
			default: 'medium',
			choices: [
				{ id: 'low', label: 'Low' },
				{ id: 'medium', label: 'Default' },
				{ id: 'high', label: 'High' },
			],
		},
	]
}
