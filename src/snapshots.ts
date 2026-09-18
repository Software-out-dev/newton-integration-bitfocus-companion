import type { CompanionActionInfo } from '@companion-module/base'
import { MIN_SNAPSHOT_FIRMWARE } from './protocol/constants.js'
import type { SnapshotInfo } from './protocol/types.js'

/**
 * Single source of truth for "does this uuid still exist on the device",
 * shared by the snapshot actions and the label feedback so they can never
 * disagree on whether a snapshot is applicable.
 */
export function findSnapshot(snapshotList: SnapshotInfo[], uuid: string): SnapshotInfo | undefined {
	return snapshotList.find((snapshot) => snapshot.uuid === uuid)
}

/**
 * Validate and normalize the Snapshot Get Database reply before it becomes
 * live Companion state. An empty `snaplist` is valid; a reply which has no
 * documented list at all is not an empty database and must remain unconfirmed.
 *
 * A few older captures used `snapshots`/`database`, so retain those aliases
 * without accepting arbitrary JSON as a successful database read.
 */
export function parseSnapshotDatabase(payload: Record<string, unknown> | null): SnapshotInfo[] | null {
	if (!payload) return null

	const entries = Array.isArray(payload.snaplist)
		? payload.snaplist
		: Array.isArray(payload.snapshots)
			? payload.snapshots
			: Array.isArray(payload.database)
				? payload.database
				: null
	if (!entries) return null

	const snapshots: SnapshotInfo[] = []
	const uuids = new Set<string>()
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) return null
		const record = entry as Record<string, unknown>
		const uuid = typeof record.uuid === 'string' ? record.uuid.trim() : ''
		if (!uuid || uuids.has(uuid)) return null
		uuids.add(uuid)

		const name =
			typeof record.name === 'string' && record.name.trim()
				? record.name.trim()
				: typeof record.description === 'string' && record.description.trim()
					? record.description.trim()
					: uuid.slice(0, 8)
		snapshots.push({ uuid, name })
	}

	return snapshots
}

/**
 * Placeholder for the snapshot dropdowns (actions and feedbacks share the
 * same wording): explains WHY the list is empty instead of guessing.
 */
export function snapshotPlaceholderLabel(count: number, unsupported: boolean, loaded: boolean): string {
	if (unsupported) return `Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later`
	if (count > 0) return 'Select a snapshot…'
	if (loaded) return 'No snapshots on device'
	return 'Snapshot database not read yet (run "Refresh Snapshot Database")'
}

/** Tracks action selections for labels only; the action remains the recall source. */
export class SnapshotActionSelections {
	private readonly actions = new Map<string, { controlId: string; uuid: string }>()

	constructor(private readonly changed: () => void = () => {}) {}

	subscribe(action: CompanionActionInfo): void {
		this.actions.set(action.id, { controlId: action.controlId, uuid: String(action.options['uuid'] ?? '').trim() })
		this.changed()
	}

	unsubscribe(action: CompanionActionInfo): void {
		if (this.actions.delete(action.id)) this.changed()
	}

	/** null means conflicting selections on one control; blank means unconfigured. */
	getUuid(controlId: string): string | null {
		const selections = new Set(
			[...this.actions.values()].filter((action) => action.controlId === controlId).map((action) => action.uuid),
		)
		return selections.size > 1 ? null : (selections.values().next().value ?? '')
	}
}
