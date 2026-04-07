import { log } from "../logger.ts"
import type { SupermemoryConfig } from "../config.ts"

/**
 * LLM completion function type.
 * Takes a system prompt and user prompt, returns the model's text response.
 * Returns empty string on failure (non-blocking).
 */
export type LlmCompletionFn = (
	system: string,
	prompt: string,
	maxTokens?: number,
) => Promise<string>

/** Timeout for LLM calls (ms). */
const LLM_TIMEOUT_MS = 10_000

/**
 * Create an LLM completion function using pi-ai.
 *
 * Model-neutral: uses config overrides or OpenClaw runtime defaults.
 * No hardcoded model names, provider names, or API endpoints.
 *
 * @param runtime - OpenClaw plugin runtime (for model auth + defaults)
 * @param cfg - Plugin config (for llmAssist overrides)
 */
export function createLlmCompletion(
	runtime: {
		agent: {
			defaults: {
				model: string
				provider: string
			}
		}
		modelAuth: {
			getApiKeyForModel: (params: {
				model: { id: string; provider: string; api: string; name?: string }
				cfg?: unknown
			}) => Promise<{ apiKey?: string } | undefined>
			resolveApiKeyForProvider: (params: {
				provider: string
				cfg?: unknown
			}) => Promise<{ apiKey?: string } | undefined>
		}
	},
	cfg: SupermemoryConfig,
	runtimeConfig?: unknown,
): LlmCompletionFn | undefined {
	if (!cfg.llmAssist.enabled) return undefined

	return async (system: string, prompt: string, maxTokens?: number): Promise<string> => {
		try {
			// Resolve model + provider from config → runtime defaults
			const defaultModelRef = runtime.agent.defaults.model ?? ""
			const defaultProvider = runtime.agent.defaults.provider ?? ""

			// Parse "provider/model" format from defaults if present
			let provider = cfg.llmAssist.provider ?? ""
			let modelId = cfg.llmAssist.model ?? ""

			// Resolve missing fields from runtime defaults
			if (!provider) provider = defaultProvider
			if (!modelId) {
				// defaultModelRef may be "provider/model" format — extract just the model part
				if (defaultModelRef.includes("/")) {
					const [p, ...rest] = defaultModelRef.split("/")
					if (!provider && p) provider = p
					modelId = rest.join("/")
				} else {
					modelId = defaultModelRef
				}
			}

			if (!provider || !modelId) {
				log.warn("llm-completion: no model/provider resolved, skipping")
				return ""
			}

			// Resolve API key via runtime auth
			let apiKey: string | undefined
			try {
				const authResult = await runtime.modelAuth.resolveApiKeyForProvider({
					provider,
					cfg: runtimeConfig,
				})
				apiKey = authResult?.apiKey?.trim()
			} catch {
				// Auth resolution failed — try without key (local models)
			}

			// Dynamic import pi-ai to avoid hard dependency
			const piAi = await import("@mariozechner/pi-ai")
			// biome-ignore lint/suspicious/noExplicitAny: provider is user-configured, not a compile-time known value
			const model = piAi.getModel(provider as any, modelId)

			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

			try {
				const result = await piAi.completeSimple(
					model,
					{
						systemPrompt: system,
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					{
						maxTokens: maxTokens ?? cfg.llmAssist.maxTokens,
						temperature: 0.3,
						signal: controller.signal,
						...(apiKey && { apiKey }),
					},
				)

				const text = result.content
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { type: string; text?: string }) => b.text ?? "")
					.join("")
					.trim()

				return text
			} finally {
				clearTimeout(timeout)
			}
		} catch (err) {
			log.warn(`llm-completion: failed — ${err instanceof Error ? err.message : String(err)}`)
			return ""
		}
	}
}
