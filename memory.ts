export const MEMORY_CATEGORIES = [
	"preference",
	"fact",
	"decision",
	"entity",
	"correction",
	"confirmation",
	"other",
] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** Map categories to container suffixes for routed storage. */
export const CATEGORY_CONTAINER_SUFFIX: Record<MemoryCategory, string> = {
	preference: "preferences",
	fact: "facts",
	decision: "decisions",
	entity: "entities",
	correction: "corrections",
	confirmation: "confirmations",
	other: "", // default container, no suffix
}

export function detectCategory(text: string): MemoryCategory {
	const lower = text.toLowerCase()
	// Corrections: explicit user corrections ("no, actually", "that's wrong", "not X, use Y")
	if (
		/\b(?:no[, ]+(?:actually|use|it's)|that'?s (?:wrong|incorrect|not right)|correct(?:ion)?:|instead (?:of|use))\b/.test(
			lower,
		)
	)
		return "correction"
	if (/\b(?:prefer|like|love|hate|want|always use|favorite)\b/.test(lower))
		return "preference"
	if (/\b(?:decided|will use|going with|let'?s use|we'?ll go with)\b/.test(lower))
		return "decision"
	if (/\+\d{10,}|@[\w.-]+\.\w+|\bis called\b|\bmy name\b/.test(lower))
		return "entity"
	if (
		/\b(?:(?:my|i|we|our) (?:is|are|has|have|work|live|speak|use|study|teach))|(?:works? (?:at|for|with))|(?:born in|grew up|graduated)\b/.test(
			lower,
		)
	)
		return "fact"
	// Confirmations: positive feedback reinforcing validated approaches.
	// Placed AFTER semantic categories to avoid mis-categorizing
	// "Perfect, we'll use PostgreSQL" as confirmation instead of decision.
	if (
		/\b(?:yes[, ]+(?:exactly|that'?s? (?:it|right|correct|perfect|great))|perfect(?:ly)?|exactly (?:right|what i (?:want|need))|keep (?:doing|using) that|that'?s? (?:perfect|great|exactly right))\b/.test(
			lower,
		)
	)
		return "confirmation"
	return "other"
}

export const MAX_ENTITY_CONTEXT_LENGTH = 1500

export const DEFAULT_ENTITY_CONTEXT = `User-assistant conversation. Format: [role: user]...[user:end] and [role: assistant]...[assistant:end].

Extract atomic facts useful in FUTURE conversations. One fact per memory. Most messages are not worth remembering.

REMEMBER: lasting personal facts, stated preferences, project decisions, corrections to prior info (HIGH priority), confirmations of good approaches, named entities, explicit "remember this" requests.

DO NOT REMEMBER: one-time tasks, assistant actions, implementation details, transient intents, unconfirmed suggestions.

CATEGORIES: preference | fact | decision | entity | correction | confirmation

RULES:
- ONE fact per memory. "Prefers X and uses Y" = two separate memories, not one.
- Assistant output is CONTEXT ONLY — never attribute assistant actions to the user.
- Corrections REPLACE old facts. Confirmations reinforce validated approaches.
- Include temporal context when relevant: "As of [date], user is working on X".
- When in doubt, do NOT create a memory. Precision > recall.`

export function clampEntityContext(ctx: string): string {
	if (ctx.length <= MAX_ENTITY_CONTEXT_LENGTH) return ctx
	return ctx.slice(0, MAX_ENTITY_CONTEXT_LENGTH)
}

const INBOUND_META_SENTINELS = [
	"Conversation info (untrusted metadata):",
	"Sender (untrusted metadata):",
	"Thread starter (untrusted, for context):",
	"Replied message (untrusted, for context):",
	"Forwarded message context (untrusted metadata):",
	"Chat history since last reply (untrusted, for context):",
]

const LEADING_TIMESTAMP_RE =
	/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */

function isMetaSentinel(line: string): boolean {
	const trimmed = line.trim()
	return INBOUND_META_SENTINELS.some((s) => s === trimmed)
}

export function stripInboundMetadata(text: string): string {
	if (!text) return text

	const withoutTimestamp = text.replace(LEADING_TIMESTAMP_RE, "")
	const lines = withoutTimestamp.split("\n")
	const result: string[] = []
	let inMetaBlock = false
	let inFencedJson = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		if (!inMetaBlock && isMetaSentinel(line)) {
			const next = lines[i + 1]
			if (next?.trim() !== "```json") {
				result.push(line)
				continue
			}
			inMetaBlock = true
			inFencedJson = false
			continue
		}

		if (inMetaBlock) {
			if (!inFencedJson && line.trim() === "```json") {
				inFencedJson = true
				continue
			}
			if (inFencedJson) {
				if (line.trim() === "```") {
					inMetaBlock = false
					inFencedJson = false
				}
				continue
			}
			if (line.trim() === "") continue
			inMetaBlock = false
		}

		result.push(line)
	}

	return result.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
}

export function buildDocumentId(sessionKey: string): string {
	const sanitized = sessionKey
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
	return `session_${sanitized}`
}

export function buildTurnDocumentId(
	sessionKey: string,
	turnIndex: number,
): string {
	const sanitized = sessionKey
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
	const uuid = crypto.randomUUID()
	return `session_${sanitized}_t${turnIndex}_${uuid}`
}
