/**
 * Text similarity utilities backed by wink-distance.
 * All functions return **similarity** (1 = identical, 0 = completely different),
 * inverting wink-distance's convention (which returns distance).
 */
import wd from "wink-distance"

// ── Thresholds (centralised so callers don't hardcode magic numbers) ──

/** Near-duplicate threshold for profile dedup in client.ts */
export const DEDUP_SIMILARITY_THRESHOLD = 0.85

/** Stricter threshold for recall injection dedup (avoid dropping distinct memories) */
export const RECALL_DEDUP_SIMILARITY_THRESHOLD = 0.90

// ── Helpers ──

/** Strip punctuation and lowercase a string for BoW construction. */
function normalise(s: string): string {
	return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
}

/** Convert a raw string into a bag-of-words object { word: count }. */
export function toBow(text: string): Record<string, number> {
	const bow: Record<string, number> = {}
	for (const word of normalise(text).split(" ")) {
		if (word) bow[word] = (bow[word] ?? 0) + 1
	}
	return bow
}

// ── Similarity functions (all return 0–1, 1 = identical) ──

/**
 * Character-level string similarity using Jaro-Winkler.
 * Best for short strings like memory texts, names, preferences.
 * Handles typos, case differences, and punctuation variations.
 */
export function textSimilarity(a: string, b: string): number {
	if (a === b) return 1
	const normA = normalise(a)
	const normB = normalise(b)
	if (normA === normB) return 1
	return 1 - wd.string.jaroWinkler(normA, normB)
}

/**
 * Bag-of-words cosine similarity.
 * Best for longer texts where word frequency matters more than character order.
 * Handles stop words implicitly through frequency weighting.
 */
export function bowSimilarity(a: string, b: string): number {
	const bowA = toBow(a)
	const bowB = toBow(b)
	return 1 - wd.bow.cosine(bowA, bowB)
}
