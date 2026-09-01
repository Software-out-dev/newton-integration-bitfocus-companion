import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { DEFAULT_CONFIG, diffConfig, getConfigFields, normalizeConfig, type ModuleConfig } from './config.js'
import { SETTINGS } from './settings.js'
import { getActionDefinitions } from './actions.js'
import { bindActionClient } from './action-client.js'
import { getFeedbackDefinitions, gainKey } from './feedbacks.js'
import { buildDeviceVariables, buildVuVariables, getVariableDefinitions } from './variables.js'
import { CLOCK_FEEDBACK_IDS, NewtonSession, PRIORITY_FEEDBACK_IDS } from './newton-session.js'
import type { GainReadState, NewtonActionResult } from './protocol/types.js'

/**
 * Companion adapter: config lifecycle, definition registration, per-control
 * maps and variable/feedback publishing. Everything device-facing — sockets,
 * timers, polling and the polled state — lives in NewtonSession, which
 * reaches back only through the narrow SessionHost callbacks below.
 */
export class NewtonInstance extends InstanceBase<ModuleConfig> {
	private config: ModuleConfig = { ...DEFAULT_CONFIG }
	private destroyed = false
	private vuPublishTimer: ReturnType<typeof setTimeout> | null = null
	private lastVuPublish = 0
	// Per-control references let paired Success/Error feedbacks share one
	// stored outcome without retaining results for controls that no longer use
	// the feedback.
	private lastActionFeedbackRefs = new Map<string, number>()

	// controlId -> input number, written by the rearm label feedback and read
	// by the 'rearm_this_input' action so one option drives the whole button.
	private rearmTargets = new Map<string, number>()

	// feedback-instance id -> channel shown on Levels & Mute buttons. The set
	// determines whether the full preset-audio refresh is needed at all.
	private gainSubs = new Map<string, { channelType: number; channelIndex: number }>()
	// Read-modify-write gain/mute actions retain this lock across definition
	// refreshes, so snapshot/config updates cannot reopen a same-channel race.
	private gainMutationQueues = new Map<string, Promise<void>>()

	// controlId -> clock type, written by the clock rearm label feedback and
	// read by the 'rearm_this_clock' action.
	private clockRearmTargets = new Map<string, number>()

	// controlId -> snapshot uuid, written by the snapshot label feedback and
	// read by the 'apply_this_snapshot' action.
	private snapshotTargets = new Map<string, string>()

	// controlId -> channel, written by the channel-mute feedback and read by
	// the 'mute_this_channel' action.
	private muteTargets = new Map<string, { channelType: number; channelIndex: number }>()

	private readonly session = new NewtonSession({
		log: (level, message) => this.log(level, message),
		updateStatus: (status, message) => this.updateStatus(status, message),
		updateVariables: () => this.updateVariables(),
		checkFeedbacks: (...feedbackIds) => this.checkFeedbacks(...feedbackIds),
		updateVuVariables: () => this.updateVuVariables(),
		publishVuVariablesNow: () => this.publishVuVariablesNow(),
		refreshDefinitions: () => this.setupDefinitions(),
		hasGainSubscribers: () => this.gainSubs.size > 0,
	})

	async init(config: ModuleConfig): Promise<void> {
		this.destroyed = false
		this.config = normalizeConfig(config)
		this.session.configure(this.config)
		this.updateStatus(InstanceStatus.Disconnected)

		if (this.config.host) {
			this.session.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}
		// Definitions capture the newly created TCP client. If there is no host,
		// the offline binding returns a clear action failure until one is saved.
		this.setupDefinitions()

		if (this.config.host) this.session.startVuListener()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.clearVuPublishTimer()
		this.session.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const next = normalizeConfig(config)
		const { targetChanged, meterChanged, gainMuteChanged } = diffConfig(this.config, next)

		// Saving an unchanged configuration must not abort a command currently in
		// flight, and each polling interval restarts only the subsystem it
		// governs; neither interval touches the TCP session.
		if (!targetChanged && !meterChanged && !gainMuteChanged) return

		this.config = next
		this.session.configure(next)

		if (targetChanged) {
			this.session.stop()
			this.session.resetDeviceState()
			this.lastVuPublish = 0
			if (this.config.host) {
				this.session.connectToDevice()
				this.session.startVuListener()
			} else {
				this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			}
			// Snapshot choices are device-specific. Rebuild definitions only after
			// the replacement client exists, so old callbacks cannot resolve it.
			this.setupDefinitions()
		} else {
			if (meterChanged && this.config.host) {
				// VuListener fixes its interval at construction time, so recreate it
				// for the new cadence without touching TCP.
				this.lastVuPublish = 0
				this.session.startVuListener()
			}
			if (gainMuteChanged && this.session.isConnected()) {
				// Restart the 0x21 scheduler without resetting its single-flight
				// gate, so an in-flight transfer remains the sole active read. While
				// disconnected the 'connected' handler arms it with the new interval.
				this.session.startPresetAudioPolling()
			}
		}

		this.updateVariables()
		this.checkFeedbacks(
			...PRIORITY_FEEDBACK_IDS,
			...CLOCK_FEEDBACK_IDS,
			'connection_status',
			'connection_monitor',
			'channel_gain',
			'channel_mute',
			'snapshot_apply_label',
			'last_action_success',
			'last_action_error',
		)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	private setupDefinitions(): void {
		const state = this.session.getState()
		const actionClient = bindActionClient(
			this.session.getClient(),
			SETTINGS.commandTimeoutMs,
			SETTINGS.actionQueueTtlMs,
		)
		const actionLogger = {
			log: this.log.bind(this),
			reportActionResult: (result: NewtonActionResult) => this.handleActionResult(result),
			// A level action just changed a gain: refresh gain/mute buttons at
			// once instead of waiting for the next poll rotation.
			reportGainRead: (channelType: number, channelIndex: number, read: GainReadState) => {
				this.session.getState().gainReads.set(gainKey(channelType, channelIndex), read)
				this.checkFeedbacks('channel_gain', 'channel_mute')
			},
		}

		this.setActionDefinitions(
			getActionDefinitions(
				actionClient,
				actionLogger,
				this.rearmTargets,
				this.clockRearmTargets,
				state.snapshotList,
				this.snapshotTargets,
				this.muteTargets,
				() => this.session.getState().snapshotsUnsupported,
				() => this.session.getState().snapshotDatabaseLoaded,
				this.gainMutationQueues,
			),
		)
		this.setFeedbackDefinitions(
			getFeedbackDefinitions(
				() => this.session.getState(),
				this.rearmTargets,
				this.gainSubs,
				this.clockRearmTargets,
				this.snapshotTargets,
				state.snapshotList,
				this.muteTargets,
				this.lastActionFeedbackRefs,
			),
		)
		this.setVariableDefinitions(getVariableDefinitions())

		this.updateVariables()
		this.updateVuVariables()
	}

	private handleActionResult(result: NewtonActionResult): void {
		const state = this.session.getState()
		state.lastActionName = result.name
		state.lastActionStatus = result.success ? 'success' : 'error'
		state.lastActionResponseHex = result.responseHex
		if (result.controlId && this.lastActionFeedbackRefs.has(result.controlId)) {
			state.lastActionResults.set(result.controlId, result)
		}
		if (!result.success) state.lastError = result.error ?? `${result.name} failed`
		this.updateVariables()
		this.checkFeedbacks('last_action_success', 'last_action_error')
	}

	// ===== Variable publishing =====

	private updateVariables(): void {
		this.setVariableValues(buildDeviceVariables(this.session.getState()))
	}

	// VU data can arrive at 20-50 Hz; publish immediately if we haven't
	// published recently, otherwise coalesce into a single trailing publish at
	// the configured meter polling interval.
	private updateVuVariables(): void {
		if (this.destroyed) return
		const interval = this.config.meter_poll_interval
		const now = Date.now()
		const elapsed = now - this.lastVuPublish
		if (elapsed >= interval) {
			this.lastVuPublish = now
			this.setVariableValues(buildVuVariables(this.session.getState()))
			this.checkFeedbacks('meter')
			return
		}
		if (this.vuPublishTimer) return
		this.vuPublishTimer = setTimeout(() => {
			this.vuPublishTimer = null
			if (this.destroyed) return
			this.lastVuPublish = Date.now()
			this.setVariableValues(buildVuVariables(this.session.getState()))
			this.checkFeedbacks('meter')
		}, interval - elapsed)
	}

	private publishVuVariablesNow(): void {
		if (this.destroyed) return
		this.clearVuPublishTimer()
		this.lastVuPublish = Date.now()
		this.setVariableValues(buildVuVariables(this.session.getState()))
		this.checkFeedbacks('meter')
	}

	private clearVuPublishTimer(): void {
		if (this.vuPublishTimer) {
			clearTimeout(this.vuPublishTimer)
			this.vuPublishTimer = null
		}
	}
}
