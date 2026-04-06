import type { AgentMessage } from "openclaw/plugin-sdk"

export type OutageBufferEntry = {
	messages: AgentMessage[]
	sessionId: string
	timestamp: string
}

const DEFAULT_MAX_BUFFER_SIZE = 50

/**
 * In-memory buffer for messages that failed SM ingestion during outage.
 * On SM recovery, entries are flushed oldest-first.
 * Drops oldest entries when buffer is full to prevent memory leak.
 */
export class OutageBuffer {
	private entries: OutageBufferEntry[] = []
	private readonly maxSize: number

	constructor(maxSize = DEFAULT_MAX_BUFFER_SIZE) {
		this.maxSize = maxSize
	}

	push(entry: OutageBufferEntry): void {
		if (this.entries.length >= this.maxSize) {
			// Drop oldest to make room
			this.entries.shift()
		}
		this.entries.push(entry)
	}

	/** Drain all buffered entries (oldest first) for recovery flush. */
	flush(): OutageBufferEntry[] {
		return this.entries.splice(0, this.entries.length)
	}

	pending(): number {
		return this.entries.length
	}

	isEmpty(): boolean {
		return this.entries.length === 0
	}

	isFull(): boolean {
		return this.entries.length >= this.maxSize
	}

	clear(): void {
		this.entries.length = 0
	}
}
