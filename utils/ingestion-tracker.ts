export type IngestionState = "pending" | "ingested" | "buffered"

/**
 * Tracks ingestion state of messages for safe compaction.
 * Only messages confirmed "ingested" by SM can be safely trimmed.
 * Messages "buffered" (SM was down) or "pending" must be kept.
 */
export class IngestionTracker {
	private states = new Map<string, IngestionState>()

	markPending(id: string): void {
		this.states.set(id, "pending")
	}

	markIngested(id: string): void {
		this.states.set(id, "ingested")
	}

	markBuffered(id: string): void {
		this.states.set(id, "buffered")
	}

	getState(id: string): IngestionState | undefined {
		return this.states.get(id)
	}

	isIngested(id: string): boolean {
		return this.states.get(id) === "ingested"
	}

	/** Only ingested messages are safe to trim during compaction. */
	isSafeToTrim(id: string): boolean {
		return this.states.get(id) === "ingested"
	}

	/** Mark multiple message IDs as ingested (batch operation). */
	markAllIngested(ids: string[]): void {
		for (const id of ids) {
			this.states.set(id, "ingested")
		}
	}

	/** Mark multiple message IDs as buffered (SM outage). */
	markAllBuffered(ids: string[]): void {
		for (const id of ids) {
			this.states.set(id, "buffered")
		}
	}

	/** Count of tracked messages by state. */
	counts(): Record<IngestionState, number> {
		const result = { pending: 0, ingested: 0, buffered: 0 }
		for (const state of this.states.values()) {
			result[state]++
		}
		return result
	}

	/** Clear entries matching a session key prefix (e.g., on subagent end). */
	clearBySessionPrefix(prefix: string): void {
		for (const key of this.states.keys()) {
			if (key.startsWith(prefix)) {
				this.states.delete(key)
			}
		}
	}

	/** Clear all tracking state (e.g., on dispose). */
	clear(): void {
		this.states.clear()
	}
}
