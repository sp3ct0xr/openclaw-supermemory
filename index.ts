import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { SupermemoryClient } from "./client.ts"
import { registerCli, registerCliSetup } from "./commands/cli.ts"
import { registerCommands, registerStubCommands } from "./commands/slash.ts"
import { parseConfig, supermemoryConfigSchema } from "./config.ts"
import {
	buildCaptureHandler,
	buildSessionBuffer,
	type SessionBuffer,
} from "./hooks/capture.ts"
import { buildRecallHandler, setProfileCache } from "./hooks/recall.ts"
import { initLogger } from "./logger.ts"
import { initPathGuard } from "./utils/path-guard.ts"
import { buildMemoryRuntime, buildPromptSection } from "./runtime.ts"
import { registerForgetTool } from "./tools/forget.ts"
import { registerProfileTool } from "./tools/profile.ts"
import { registerSearchTool } from "./tools/search.ts"
import { registerStoreTool } from "./tools/store.ts"
import { registerDocumentsTool } from "./tools/documents.ts"
import { registerIngestTool } from "./tools/ingest.ts"
import { registerSettingsTool } from "./tools/settings.ts"
import { registerUpdateTool } from "./tools/update.ts"
import { registerTimelineTool } from "./tools/timeline.ts"
import { buildPostCompactHandler } from "./hooks/post-compact.ts"
import { buildContextEngine } from "./engine/context-engine.ts"

try {
	const stateDir =
		process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw")
	const storePath = path.join(stateDir, "memory", "main.sqlite")
	if (!fs.existsSync(storePath)) {
		fs.mkdirSync(path.dirname(storePath), { recursive: true })
		fs.writeFileSync(storePath, "")
	}
} catch {}

export default {
	id: "openclaw-supermemory",
	name: "Supermemory",
	description: "OpenClaw powered by Supermemory plugin",
	kind: "memory" as const,
	configSchema: supermemoryConfigSchema,

	register(api: OpenClawPluginApi) {
		const cfg = parseConfig(api.pluginConfig)

		initLogger(api.logger, cfg.debug)
		initPathGuard(api)

		registerCliSetup(api)

		if (!cfg.apiKey) {
			api.logger.info(
				"supermemory: not configured - run 'openclaw supermemory setup'",
			)
			registerStubCommands(api)
			return
		}

		const client = new SupermemoryClient(cfg.apiKey, cfg.containerTag)
		if (cfg.v4FetchTimeoutMs !== 10_000) {
			client.setV4FetchTimeout(cfg.v4FetchTimeoutMs)
		}

		let sessionKey: string | undefined
		const getSessionKey = () => sessionKey

		// Session buffer: accumulates turns, flushes as batch
		const sessionBuffer: SessionBuffer = buildSessionBuffer(
			client,
			cfg,
			getSessionKey,
		)

		api.registerMemoryRuntime?.(buildMemoryRuntime(client))
		api.registerMemoryPromptSection?.((toolParams: { availableTools: Set<string> }) =>
			buildPromptSection({ ...toolParams, contextEngineActive: cfg.contextEngine }),
		)
		api.registerMemoryFlushPlan?.(() => {
			if (sessionBuffer.pending() === 0) return null
			return async () => {
				await sessionBuffer.flush()
			}
		})

		registerSearchTool(api, client, cfg)
		registerStoreTool(api, client, cfg, getSessionKey)
		registerUpdateTool(api, client, cfg)
		registerForgetTool(api, client, cfg)
		registerProfileTool(api, client, cfg)
		registerIngestTool(api, client, cfg)
		registerDocumentsTool(api, client, cfg)
		registerSettingsTool(api, client, cfg)
		registerTimelineTool(api, client, cfg)

		// Sync org-level settings from plugin config → Supermemory on startup.
		// Note: this is one-way (config → server). If settings are changed via
		// the supermemory_settings tool mid-session, cfg remains stale.
		// This is fine because nothing reads cfg.filterPrompt after startup.
		if (cfg.filterPrompt !== undefined || cfg.shouldLLMFilter !== undefined) {
			client
				.updateSettings({
					...(cfg.filterPrompt !== undefined && { filterPrompt: cfg.filterPrompt }),
					...(cfg.shouldLLMFilter !== undefined && { shouldLLMFilter: cfg.shouldLLMFilter }),
				})
				.then(() => api.logger.info("supermemory: org settings synced from config"))
				.catch((err) =>
					api.logger.warn(
						`supermemory: failed to sync org settings: ${err instanceof Error ? err.message : String(err)}`,
					),
				)
		}

		// CE handles context assembly → skip autoRecall when CE is active
		if (cfg.autoRecall && !cfg.contextEngine) {
			const recallHandler = buildRecallHandler(client, cfg)
			api.on(
				"before_prompt_build",
				(event: Record<string, unknown>, ctx: Record<string, unknown>) => {
					if (ctx.sessionKey) sessionKey = ctx.sessionKey as string
					return recallHandler(event, ctx)
				},
			)
		}

		// CE handles ingestion → skip autoCapture when CE is active
		if (cfg.autoCapture && !cfg.contextEngine) {
			api.on(
				"agent_end",
				buildCaptureHandler(client, cfg, getSessionKey, sessionBuffer),
			)
		}

		// session_start: warm profile cache (P2 item #11)
		api.on("session_start", async (_event: Record<string, unknown>, ctx: Record<string, unknown>) => {
			if (ctx?.sessionKey) sessionKey = ctx.sessionKey as string
			// Fire-and-forget warmup — don't block session start
			client.getProfile(undefined)
				.then((profile) => {
					setProfileCache(profile, cfg.profileCacheTtlMs)
					api.logger.info("supermemory: SessionStart — profile cache warmed")
				})
				.catch(() => {}) // warmup failure is non-critical
		})

		// after_compaction: re-inject SM memories after context loss (P2 item #8)
		api.on("after_compaction", buildPostCompactHandler(client, cfg))

		// before_compaction: flush SM buffer before compaction strips context (P1 item #1)
		// Prevents data loss when compaction fires before agent_end
		api.on("before_compaction", async () => {
			if (sessionBuffer.pending() > 0) {
				api.logger.info(`supermemory: PreCompact — flushing ${sessionBuffer.pending()} pending turns`)
				try {
					await sessionBuffer.flush()
				} catch (err) {
					api.logger.error("supermemory: PreCompact flush failed", err)
				}
			}
		})

		// Register context engine if enabled
		if (cfg.contextEngine) {
			const engine = buildContextEngine(client, cfg, api.logger)
			// Dual registration: works with both "supermemory-context" and "default" slot config
			api.registerContextEngine?.("supermemory-context", () => engine)
			api.registerContextEngine?.("default", () => engine)
			api.logger.info("supermemory: context engine registered (ownsCompaction: true)")
		}

		// session_end: flush pending buffer when session ends
		api.on("session_end", async () => {
			if (sessionBuffer.pending() > 0) {
				api.logger.debug(`supermemory: session_end — flushing ${sessionBuffer.pending()} pending turns`)
				try {
					await sessionBuffer.flush()
				} catch (err) {
					api.logger.warn(`supermemory: session_end flush failed: ${err instanceof Error ? err.message : String(err)}`)
				}
			}
		})

		registerCommands(api, client, cfg, getSessionKey)
		registerCli(api, client, cfg)

		api.registerService({
			id: "openclaw-supermemory",
			start: () => {
				api.logger.info("supermemory: connected")
			},
			stop: async () => {
				api.logger.info("supermemory: flushing buffer before stop")
				try {
					await sessionBuffer.flush()
				} catch (err) {
					api.logger.error("supermemory: flush on stop failed", err)
				}
				api.logger.info("supermemory: stopped")
			},
		})
	},
}
