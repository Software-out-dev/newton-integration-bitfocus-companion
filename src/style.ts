import { combineRgb } from '@companion-module/base'

/**
 * Shared visual language for the feedback-driven button styles, so the module
 * looks like one product instead of a pile of defaults. State colors are
 * saturated but not neon.
 */
export const UI = {
	/** Healthy / open / online. */
	green: combineRgb(0, 150, 64),
	/** Backup engaged / attention. */
	orange: combineRgb(230, 115, 0),
	/** Muted / offline / alarm. */
	red: combineRgb(195, 30, 45),
	textPrimary: combineRgb(255, 255, 255),
} as const
