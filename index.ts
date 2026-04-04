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
import { buildRecallHandler } from "./hooks/recall.ts"
import { initLogger } from "./logger.ts"
import { buildMemoryRuntime, buildPromptSection } from "./runtime.ts"
import { registerForgetTool } from "./tools/forget.ts"
import { registerProfileTool } from "./tools/profile.ts"
import { registerSearchTool } from "./tools/search.ts"
import { registerStoreTool } from "./tools/store.ts"
import { registerSettingsTool } from "./tools/settings.ts"
import { registerUpdateTool } from "./tools/update.ts"

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

		registerCliSetup(api)

		if (!cfg.apiKey) {
			api.logger.info(
				"supermemory: not configured - run 'openclaw supermemory setup'",
			)
			registerStubCommands(api)
			return
		}

		const client = new SupermemoryClient(cfg.apiKey, cfg.containerTag)

		let sessionKey: string | undefined
		const getSessionKey = () => sessionKey

		// Session buffer: accumulates turns, flushes as batch
		const sessionBuffer: SessionBuffer = buildSessionBuffer(
			client,
			cfg,
			getSessionKey,
		)

		api.registerMemoryRuntime?.(buildMemoryRuntime(client))
		api.registerMemoryPromptSection?.(buildPromptSection)
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
		registerSettingsTool(api, client, cfg)

		// Sync org-level settings from plugin config on startup
		if (cfg.filterPrompt !== undefined || cfg.shouldLLMFilter !== undefined) {
			client
				.updateSettings({
					...(cfg.filterPrompt !== undefined && { filterPrompt: cfg.filterPrompt }),
					...(cfg.shouldLLMFilter !== undefined && { shouldLLMFilter: cfg.shouldLLMFilter }),
				})
				.then(() => api.logger.info("supermemory: org settings synced from config"))
				.catch((err) => api.logger.warn(`supermemory: failed to sync org settings: ${err}`))
		}

		if (cfg.autoRecall) {
			const recallHandler = buildRecallHandler(client, cfg)
			api.on(
				"before_agent_start",
				(event: Record<string, unknown>, ctx: Record<string, unknown>) => {
					if (ctx.sessionKey) sessionKey = ctx.sessionKey as string
					return recallHandler(event, ctx)
				},
			)
		}

		if (cfg.autoCapture) {
			api.on(
				"agent_end",
				buildCaptureHandler(client, cfg, getSessionKey, sessionBuffer),
			)
		}

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
