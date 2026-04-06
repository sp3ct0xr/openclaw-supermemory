import type { CustomContainer } from "../config.ts"

export type QueryComplexity = "simple" | "knowledge" | "multihop"

export type QueryClassification = {
	complexity: QueryComplexity
	temporal?: { after?: string; before?: string }
	containerHint?: string
}

// ── Complexity patterns ──

const SIMPLE_PATTERNS = [
	/^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|yes|no|sure|yep|nope|got it|cool|nice|great|perfect|done|bye|goodbye)\b/i,
	/^(what time|what day|what date)\b/i,
]

const MULTIHOP_PATTERNS = [
	/\b(compare|vs\.?|versus|difference between|contrast|changed from|evolved)\b/i,
	/\b(march|april|may|june|july|august|september|october|november|december|january|february)\b.*\b(and|vs\.?|to|with)\b.*\b(march|april|may|june|july|august|september|october|november|december|january|february)\b/i,
]

// ── Temporal extraction ──

const MONTH_MAP: Record<string, number> = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
	aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function toISODate(d: Date): string {
	return d.toISOString().split("T")[0]!
}

function extractTemporal(prompt: string): { after?: string; before?: string } | undefined {
	const lower = prompt.toLowerCase()
	const now = new Date()
	const result: { after?: string; before?: string } = {}

	// Relative: "yesterday"
	if (/\byesterday\b/.test(lower)) {
		const d = new Date(now)
		d.setDate(d.getDate() - 1)
		result.after = toISODate(d)
		return result
	}

	// Relative: "last week"
	if (/\blast\s+week\b/.test(lower)) {
		const d = new Date(now)
		d.setDate(d.getDate() - 7)
		result.after = toISODate(d)
		return result
	}

	// Relative: "last month"
	if (/\blast\s+month\b/.test(lower)) {
		const d = new Date(now)
		d.setMonth(d.getMonth() - 1)
		result.after = toISODate(d)
		return result
	}

	// Relative: "last N days"
	const lastNDays = lower.match(/\blast\s+(\d+)\s+days?\b/)
	if (lastNDays?.[1]) {
		const d = new Date(now)
		d.setDate(d.getDate() - Number.parseInt(lastNDays[1], 10))
		result.after = toISODate(d)
		return result
	}

	// Relative: "recently" / "recent"
	if (/\brecent(?:ly)?\b/.test(lower)) {
		const d = new Date(now)
		d.setDate(d.getDate() - 7)
		result.after = toISODate(d)
		return result
	}

	// "before <month>" / "after <month>" / "since <month>"
	const beforeMonth = lower.match(/\bbefore\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/)
	if (beforeMonth?.[1]) {
		const month = MONTH_MAP[beforeMonth[1]]
		if (month !== undefined) {
			const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear()
			result.before = `${year}-${String(month).padStart(2, "0")}-01`
			return result
		}
	}

	const afterMonth = lower.match(/\b(?:after|since)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/)
	if (afterMonth?.[1]) {
		const month = MONTH_MAP[afterMonth[1]]
		if (month !== undefined) {
			const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear()
			result.after = `${year}-${String(month).padStart(2, "0")}-01`
			return result
		}
	}

	// "in <month>" → scope to that month
	const inMonth = lower.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/)
	if (inMonth?.[1]) {
		const month = MONTH_MAP[inMonth[1]]
		if (month !== undefined) {
			const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear()
			result.after = `${year}-${String(month).padStart(2, "0")}-01`
			const nextMonth = month === 12 ? 1 : month + 1
			const nextYear = month === 12 ? year + 1 : year
			result.before = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`
			return result
		}
	}

	return undefined
}

// ── Container hint extraction ──

/** Tokenize text into lowercase words for keyword matching. */
function tokenize(text: string): Set<string> {
	return new Set(
		text.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3),
	)
}

function extractContainerHint(
	prompt: string,
	containers: CustomContainer[],
): string | undefined {
	if (containers.length === 0) return undefined

	const promptWords = tokenize(prompt)
	let bestTag: string | undefined
	let bestScore = 0

	for (const container of containers) {
		const descWords = tokenize(container.description)
		// Also include the tag itself as a keyword
		const tagWords = tokenize(container.tag.replace(/_/g, " "))
		const allKeywords = new Set([...descWords, ...tagWords])

		let score = 0
		for (const word of promptWords) {
			if (allKeywords.has(word)) score++
		}

		if (score >= 2 && score > bestScore) {
			bestScore = score
			bestTag = container.tag
		}
	}

	return bestTag
}

// ── Main classifier ──

export function classifyQuery(
	prompt: string | undefined,
	containers?: CustomContainer[],
): QueryClassification {
	if (!prompt || prompt.trim().length === 0) {
		return { complexity: "simple" }
	}

	const trimmed = prompt.trim()

	// Simple: very short or greeting/command pattern
	if (trimmed.length < 20 && !trimmed.includes("?")) {
		return { complexity: "simple" }
	}
	// Single word
	if (!/\s/.test(trimmed)) {
		return { complexity: "simple" }
	}
	for (const pattern of SIMPLE_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { complexity: "simple" }
		}
	}

	// Extract temporal + container before classifying complexity
	const temporal = extractTemporal(trimmed)
	const containerHint = containers ? extractContainerHint(trimmed, containers) : undefined

	// Multihop: comparison or multiple temporal references
	for (const pattern of MULTIHOP_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { complexity: "multihop", temporal, containerHint }
		}
	}

	// Default: knowledge query
	return { complexity: "knowledge", temporal, containerHint }
}
