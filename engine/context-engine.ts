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
): ContextEngine {
	// Shared state across all lifecycle methods
	const tracker = new IngestionTracker()
	const outageBuffer = new OutageBuffer()
	const degradedMode = { value: false }
	const turnCount = { value: 0 }
	const compactionRecommended = { value: false }

	// Health probe — check SM connectivity at creation time
	client
		.search("probe", 1)
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

	const assembleHandler = buildAssembleHandler(client, cfg, degradedMode, trimOffset)
	const compactHandler = buildCompactHandler(cfg, tracker, trimOffset)
	const afterTurnHandler = buildAfterTurnHandler(ingestBatchHandler, {
		turnCount,
		compactionRecommended,
	})

	return {
		info: {
			id: "supermemory-context",
			name: "Supermemory Context Engine",
			version: "1.0.0",
			ownsCompaction: true,
		},

		bootstrap: bootstrapHandler,
		ingest: ingestHandler,
		ingestBatch: ingestBatchHandler,
		assemble: assembleHandler,
		compact: compactHandler,
		afterTurn: afterTurnHandler,

		async dispose() {
			// Flush any pending outage buffer entries
			if (!outageBuffer.isEmpty()) {
				log.info(`supermemory CE dispose: ${outageBuffer.pending()} buffered entries will be lost`)
			}
			outageBuffer.clear()
			tracker.clear()
			clearProfileCache()
			log.info("supermemory CE: disposed")
		},
	}
}
