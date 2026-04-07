import type { AgentMessage, AssembleResult } from "openclaw/plugin-sdk"
import type { QueryComplexity } from "./query-classifier.ts"
import { log } from "../logger.ts"

/** Default max entries in the response cache. */
const DEFAULT_MAX_ENTRIES = 50

/** Default TTL for cached responses (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** Minimum query length to cache (avoids caching trivial inputs). */
const MIN_QUERY_LENGTH = 20

/** Query classifications that should bypass the response cache. */
const SKIP_CLASSIFICATIONS: ReadonlySet<QueryComplexity> = new Set(["simple", "followup"])

type CacheEntry = {
	result: AssembleResult
	timestamp: number
	hitCount: number
	messagesLength: number
}

/**
 * In-memory LRU cache for assembled responses.
 *
 * When the same query is asked repeatedly within the TTL window,
 * returns the previously assembled result instead of re-running
 * profile fetch + search + budget allocation from scratch.
 *
 * Cache key: normalized query text (lowercased, trimmed).
 * Invalidated on store/update/forget mutations (via clear()).
 *
 * This is distinct from SearchCache which only caches raw SM search
 * results — ResponseCache caches the full AssembleResult including
 * system prompt additions and memory messages.
 */
export class ResponseCache {
	private cache = new Map<string, CacheEntry>()
	private maxEntries: number
	private ttlMs: number
	private totalHits = 0
	private totalMisses = 0

	constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
		this.maxEntries = maxEntries
		this.ttlMs = ttlMs
	}

	/** Normalize a query into a cache key. */
	private buildKey(query: string): string {
		return query.toLowerCase().trim().replace(/\s+/g, " ")
	}

	/**
	 * Get a cached AssembleResult for an exact (normalized) query match.
	 * Returns null on miss, stale entry, classification skip, or if query is too short.
	 */
	get(
		query: string,
		currentMessagesLength?: number,
		classification?: QueryComplexity,
	): AssembleResult | null {
		if (query.length < MIN_QUERY_LENGTH) return null

		// Skip cache for trivial/followup classifications
		if (classification && SKIP_CLASSIFICATIONS.has(classification)) {
			log.debug(`ResponseCache skip: classification="${classification}"`)
			return null
		}

		const key = this.buildKey(query)
		const entry = this.cache.get(key)
		if (!entry) {
			this.totalMisses++
			return null
		}

		// Check TTL
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key)
			this.totalMisses++
			return null
		}

		// Zone 3 staleness: evict if conversation has grown since cache time
		if (
			currentMessagesLength !== undefined &&
			entry.messagesLength !== currentMessagesLength
		) {
			this.cache.delete(key)
			this.totalMisses++
			log.debug(
				`ResponseCache evict (stale Zone 3): key="${key.slice(0, 40)}…" cached=${entry.messagesLength} current=${currentMessagesLength}`,
			)
			return null
		}

		// LRU promotion: move to end
		this.cache.delete(key)
		entry.hitCount++
		this.cache.set(key, entry)
		this.totalHits++

		log.debug(
			`ResponseCache hit: key="${key.slice(0, 40)}…" hits=${entry.hitCount} age=${Math.round((Date.now() - entry.timestamp) / 1000)}s`,
		)

		// Shallow-clone to prevent shared object reference mutation
		return { ...entry.result, messages: [...entry.result.messages] }
	}

	/**
	 * Store an AssembleResult in the cache.
	 * Skips caching for very short queries or trivial classifications.
	 */
	set(
		query: string,
		result: AssembleResult,
		messagesLength: number,
		classification?: QueryComplexity,
	): void {
		if (query.length < MIN_QUERY_LENGTH) return

		// Don't cache trivial/followup classifications
		if (classification && SKIP_CLASSIFICATIONS.has(classification)) return

		const key = this.buildKey(query)

		// Evict oldest entry if at capacity
		if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey)
			}
		}

		this.cache.set(key, {
			result,
			timestamp: Date.now(),
			hitCount: 0,
			messagesLength,
		})
	}

	/** Clear all cached responses (called on mutation). */
	clear(): void {
		const size = this.cache.size
		this.cache.clear()
		if (size > 0) {
			log.debug(`ResponseCache cleared: evicted ${size} entries`)
		}
	}

	/** Number of cached entries. */
	size(): number {
		return this.cache.size
	}

	/** Cache hit rate as a percentage (0-100). Returns 0 if no lookups yet. */
	hitRate(): number {
		const total = this.totalHits + this.totalMisses
		if (total === 0) return 0
		return Math.round((this.totalHits / total) * 100)
	}

	/** Metrics snapshot for logging. */
	metrics(): { size: number; hits: number; misses: number; hitRate: number } {
		return {
			size: this.cache.size,
			hits: this.totalHits,
			misses: this.totalMisses,
			hitRate: this.hitRate(),
		}
	}
}
