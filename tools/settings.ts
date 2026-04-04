import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerSettingsTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	_cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_settings",
			label: "Memory Settings",
			description:
				"View or update org-level Supermemory settings (filterPrompt, shouldLLMFilter, chunkSize). Use action='get' to view current settings, action='update' to change them.",
			parameters: Type.Object({
				action: Type.Unsafe<string>({
					type: "string",
					enum: ["get", "update"],
					description:
						"'get': show current settings. 'update': change one or more settings.",
				}),
				filterPrompt: Type.Optional(
					Type.String({
						description:
							"Org-wide LLM prompt controlling what gets extracted from ALL ingested content. Only used with action='update'.",
					}),
				),
				shouldLLMFilter: Type.Optional(
					Type.Boolean({
						description:
							"Enable/disable server-side LLM filtering. Must be true for filterPrompt to take effect. Only used with action='update'.",
					}),
				),
				chunkSize: Type.Optional(
					Type.Number({
						description:
							"Global chunk size for document processing. Smaller = more atomic memories. Use -1 for default. Only used with action='update'.",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					action: string
					filterPrompt?: string
					shouldLLMFilter?: boolean
					chunkSize?: number
				},
			) {
				if (params.action === "get") {
					log.debug("settings tool: getting current settings")
					const settings = await client.getSettings()

					const lines: string[] = [
						"## Current Supermemory Settings",
						"",
						`**Filter Prompt:** ${settings.filterPrompt ? `"${settings.filterPrompt}"` : "(not set)"}`,
						`**LLM Filtering:** ${settings.shouldLLMFilter === true ? "enabled" : settings.shouldLLMFilter === false ? "disabled" : "(default)"}`,
						`**Chunk Size:** ${settings.chunkSize !== null ? settings.chunkSize : "(default)"}`,
					]

					return {
						content: [
							{ type: "text" as const, text: lines.join("\n") },
						],
						details: settings,
					}
				}

				if (params.action === "update") {
					const hasUpdates =
						params.filterPrompt !== undefined ||
						params.shouldLLMFilter !== undefined ||
						params.chunkSize !== undefined

					if (!hasUpdates) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No settings provided to update. Pass filterPrompt, shouldLLMFilter, or chunkSize.",
								},
							],
						}
					}

					log.debug("settings tool: updating settings", params)
					const updated = await client.updateSettings({
						...(params.filterPrompt !== undefined && {
							filterPrompt: params.filterPrompt,
						}),
						...(params.shouldLLMFilter !== undefined && {
							shouldLLMFilter: params.shouldLLMFilter,
						}),
						...(params.chunkSize !== undefined && {
							chunkSize: params.chunkSize,
						}),
					})

					const parts: string[] = []
					if (updated.filterPrompt !== undefined)
						parts.push(`filterPrompt: "${updated.filterPrompt}"`)
					if (updated.shouldLLMFilter !== undefined)
						parts.push(
							`shouldLLMFilter: ${updated.shouldLLMFilter}`,
						)
					if (updated.chunkSize !== undefined)
						parts.push(`chunkSize: ${updated.chunkSize}`)

					return {
						content: [
							{
								type: "text" as const,
								text: `Settings updated: ${parts.join(", ")}`,
							},
						],
						details: updated,
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: "Invalid action. Use 'get' or 'update'.",
						},
					],
				}
			},
		},
		{ name: "supermemory_settings" },
	)
}
