import type { SearchResult } from "../client.ts"

/** Default max entries in the search cache. */
const DEFAULT_MAX_ENTRIES = 20

/** Default TTL for cached search results (3 minutes). */
const DEFAULT_TTL_MS = 3 * 60 * 1000

type CacheEntry = {
	results: SearchResult[]
	timestamp: number
	containerTag: string | undefined
}

/**
 * In-memory LRU search result cache.
 *
 * Used by CE assemble Zone 2 to avoid redundant SM API calls for repeated
 * queries within the same session. Explicit tool calls always bypass this.
 *
 * Cache key: exact normalized query text + containerTag.
 * Invalidated when store/update/forget tools execute (via clear()).
 */
export class SearchCache {
	private cache = new Map<string, CacheEntry>()
	private maxEntries: number
	private ttlMs: number

	constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
		this.maxEntries = maxEntries
		this.ttlMs = ttlMs
	}

	/** Build a cache key from query + containerTag. */
	private buildKey(query: string, containerTag?: string): string {
		return `${query.toLowerCase().trim()}|${containerTag ?? "__root__"}`
	}

	/** Get cached results for an exact query match. Returns null on miss or stale. */
	get(query: string, containerTag?: string): SearchResult[] | null {
		const key = this.buildKey(query, containerTag)
		const entry = this.cache.get(key)
		if (!entry) return null

		// Check TTL
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key)
			return null
		}

		// Move to end (most recently used) for LRU
		this.cache.delete(key)
		this.cache.set(key, entry)
		return entry.results
	}

	/** Store search results in the cache. */
	set(query: string, results: SearchResult[], containerTag?: string): void {
		const key = this.buildKey(query, containerTag)

		// Evict oldest entry if at capacity
		if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey)
			}
		}

		this.cache.set(key, {
			results,
			timestamp: Date.now(),
			containerTag,
		})
	}

	/** Clear all cached results (called on mutation). */
	clear(): void {
		this.cache.clear()
	}

	/** Number of cached entries (for metrics). */
	size(): number {
		return this.cache.size
	}
}
