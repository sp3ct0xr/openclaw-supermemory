import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

/** Default minimum similarity for PostCompact re-injection results */
const DEFAULT_POST_COMPACT_THRESHOLD = 0.6
/** Max memories to re-inject after compaction */
const POST_COMPACT_LIMIT = 5

/**
 * PostCompact hook handler (P2 item #8).
 *
 * After compaction strips older context, search SM for relevant memories
 * the agent may have lost and re-inject via additionalContext.
 * This bridges compaction (lossy) with SM (persistent).
 */
export function buildPostCompactHandler(
	client: SupermemoryClient,
	_cfg: SupermemoryConfig,
) {
	return async (
		event: Record<string, unknown>,
		_ctx?: Record<string, unknown>,
	) => {
		try {
			// Extract the last user message from remaining messages after compaction
			const messages = Array.isArray(event.messages) ? event.messages : []
			const lastUserMsg = [...messages]
				.reverse()
				.find(
					(m) =>
						m &&
						typeof m === "object" &&
						(m as Record<string, unknown>).role === "user",
				)

			if (!lastUserMsg) return

			const content = (lastUserMsg as Record<string, unknown>).content
			const query =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? (content as Array<Record<string, unknown>>)
								.filter((b) => b.type === "text" && typeof b.text === "string")
								.map((b) => b.text as string)
								.join(" ")
						: ""

			if (query.length < 5) return

			log.debug(`PostCompact: searching SM with query "${query.slice(0, 80)}"`)

		const threshold = _cfg.postCompactThreshold ?? DEFAULT_POST_COMPACT_THRESHOLD
			// PostCompact searches root only — it doesn't know which topic
			// container is relevant, and the last user message provides enough
			// context for SM to find the right memories in root.
			const results = await client.search(query, POST_COMPACT_LIMIT, undefined, {
				searchMode: "hybrid",
				rerank: true,
				threshold,
			})

			if (results.length === 0) {
				log.debug("PostCompact: no relevant SM memories found")
				return
			}

			const memoryLines = results
				.map((r) => `- ${r.content || r.memory || ""}`)
				.join("\n")

			log.info(
				`PostCompact: re-injecting ${results.length} SM memories after compaction`,
			)

			return {
				additionalContext: `[Supermemory: relevant context restored after compaction]\n${memoryLines}`,
			}
		} catch (err) {
			log.error("PostCompact: SM search failed", err)
			return
		}
	}
}
