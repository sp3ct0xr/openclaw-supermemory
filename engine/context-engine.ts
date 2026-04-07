import type { ContextEngine } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { clearProfileCache } from "../hooks/recall.ts"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"
import { OutageBuffer } from "../utils/outage-buffer.ts"
import { buildBootstrapHandler } from "./bootstrap.ts"
import { buildIngestHandler, buildIngestBatchHandler } from "./ingest.ts"
import { buildAssembleHandler } from "./assemble.ts"
import { buildCompactHandler } from "./compact.ts"
import { buildAfterTurnHandler } from "./after-turn.ts"
import { buildMaintainHandler } from "./maintain.ts"
import { buildOnSubagentEndedHandler } from "./subagent.ts"
import { SearchCache } from "../utils/search-cache.ts"
import type { LlmCompletionFn } from "../utils/llm-completion.ts"
import { ResponseCache } from "../utils/response-cache.ts"

/**
 * Build the Supermemory context engine.
 *
 * Shares the SM client, config, and profile cache with the memory plugin.
 * Creates its own ingestion tracker, outage buffer, and degraded mode flag.
 */
export function buildContextEngine(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	logger: { info: (msg: string) => void },
	externalSearchCache?: SearchCache,
	externalResponseCache?: ResponseCache,
	llmComplete?: LlmCompletionFn,
	lastAssembleQuery?: { value: string },
): ContextEngine & { onMutation: () => void } {
	// Shared state across all lifecycle methods
	const tracker = new IngestionTracker()
	const outageBuffer = new OutageBuffer()
	const degradedMode = { value: false }
	const turnCount = { value: 0 }
	const compactionRecommended = { value: false }
	const lastAssembledMemories = { value: [] as string[] }
	// Use external caches (plugin-scope, survive disposal) or create local ones
	const searchCache = externalSearchCache ?? new SearchCache()
	const responseCache = externalResponseCache ?? new ResponseCache()

	// Health check — verify SM connectivity via getSettings (validates API key + reachability)
	// No wasted search call — getSettings is lightweight and confirms auth works
	client
		.getSettings()
		.then(() => {
			degradedMode.value = false
			logger.info("supermemory CE: SM connectivity OK")
		})
		.catch(() => {
			degradedMode.value = true
			logger.info(
				"supermemory CE: SM unreachable at startup — operating in degraded mode (check https://status.supermemory.ai/)",
			)
		})

	// Build all handlers
	const bootstrapHandler = buildBootstrapHandler(client, cfg)
	const ingestHandler = buildIngestHandler(tracker)
	const ingestBatchHandler = buildIngestBatchHandler(
		client,
		cfg,
		tracker,
		outageBuffer,
		degradedMode,
	)
	// trimOffset: compact writes how many messages to skip, assemble consumes it
	const trimOffset = { value: 0 }

	const assembleHandler = buildAssembleHandler(client, cfg, degradedMode, trimOffset, lastAssembledMemories, searchCache, responseCache, lastAssembleQuery)
	const compactHandler = buildCompactHandler(cfg, tracker, trimOffset, compactionRecommended)
	const afterTurnHandler = buildAfterTurnHandler(ingestBatchHandler, {
		turnCount,
		compactionRecommended,
		lastAssembledMemories,
	})
	const maintainHandler = buildMaintainHandler(tracker, llmComplete)
	const onSubagentEndedHandler = buildOnSubagentEndedHandler(tracker)

	return {
		info: {
			id: "supermemory-context",
			name: "Supermemory Context Engine",
			version: "2.0.0",
			ownsCompaction: true,
		},

		bootstrap: bootstrapHandler,
		ingest: ingestHandler,
		ingestBatch: ingestBatchHandler,
		assemble: assembleHandler,
		compact: compactHandler,
		afterTurn: afterTurnHandler,
		maintain: maintainHandler,
		onSubagentEnded: onSubagentEndedHandler,

		/** Clear all caches (called by tools on mutation). */
		onMutation() {
			clearProfileCache()
			searchCache.clear()
			responseCache.clear()
			log.debug("CE: caches cleared (mutation detected)")
		},

		async dispose() {
			if (!outageBuffer.isEmpty()) {
				log.info(`supermemory CE dispose: ${outageBuffer.pending()} buffered entries will be lost`)
			}
			outageBuffer.clear()
			tracker.clear()
			// Don't clear external caches on dispose — they live at plugin scope
			if (!externalSearchCache) searchCache.clear()
			if (!externalResponseCache) responseCache.clear()
			// Don't clear profile cache on dispose — it lives at module scope
			log.info("supermemory CE: disposed")
		},
	}
}
