import { hostname } from "node:os"
import { DEFAULT_ENTITY_CONTEXT } from "./memory.ts"

export type CaptureMode = "everything" | "all"

export type CustomContainer = {
	tag: string
	description: string
}

export type SupermemoryConfig = {
	apiKey: string | undefined
	containerTag: string
	autoRecall: boolean
	autoCapture: boolean
	maxRecallResults: number
	profileFrequency: number
	/** TTL in milliseconds for SM profile cache. Default: 60000 (60s).
	 *  Reduces API calls by caching profile responses between turns. */
	profileCacheTtlMs: number
	/** Minimum similarity threshold for PostCompact SM re-injection. Default: 0.6.
	 *  Higher = fewer but more relevant memories re-injected after compaction. */
	postCompactThreshold: number
	/** Timeout in ms for raw SM v4 API calls (createMemoryDirect). Default: 10000 (10s). */
	v4FetchTimeoutMs: number
	captureMode: CaptureMode
	entityContext: string
	debug: boolean
	enableCustomContainerTags: boolean
	customContainers: CustomContainer[]
	customContainerInstructions: string
	/** Org-wide LLM prompt controlling what gets extracted from ALL ingested content.
	 *  Different from entityContext (per-container). Leave undefined to use Supermemory defaults. */
	filterPrompt: string | undefined
	/** Enable server-side LLM filtering during ingestion.
	 *  Must be true for filterPrompt to take effect. */
	shouldLLMFilter: boolean | undefined
	/** Enable context engine registration. When true, plugin registers a ContextEngine
	 *  that controls context assembly, ingestion, and compaction. autoCapture and autoRecall
	 *  are auto-disabled when this is active. Default: false. */
	contextEngine: boolean
	/** Number of recent messages to keep verbatim after compaction. Default: 10. */
	compactKeepLast: number
	/** SM search similarity threshold for context assembly. Higher = fewer but more relevant
	 *  memories injected. Default: 0.7. */
	assembleThreshold: number
	/** Use SM v4 Conversations API for ingestion instead of addMemory.
	 *  Passes structured messages directly. Default: true. */
	useConversationsApi: boolean
	/** Ingest debounce: batch N turns before sending to SM. Default: 1 (no debounce). */
	ingestDebounceCount: number
}

const ALLOWED_KEYS = [
	"apiKey",
	"containerTag",
	"autoRecall",
	"autoCapture",
	"maxRecallResults",
	"profileFrequency",
	"profileCacheTtlMs",
	"postCompactThreshold",
	"v4FetchTimeoutMs",
	"captureMode",
	"entityContext",
	"debug",
	"enableCustomContainerTags",
	"customContainers",
	"customContainerInstructions",
	"filterPrompt",
	"shouldLLMFilter",
	"contextEngine",
	"compactKeepLast",
	"assembleThreshold",
	"useConversationsApi",
	"ingestDebounceCount",
]

function assertAllowedKeys(
	value: Record<string, unknown>,
	allowed: string[],
	label: string,
): void {
	const unknown = Object.keys(value).filter((k) => !allowed.includes(k))
	if (unknown.length > 0) {
		throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
	}
}

function resolveEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
		const envValue = process.env[envVar]
		if (!envValue) {
			throw new Error(`Environment variable ${envVar} is not set`)
		}
		return envValue
	})
}

function sanitizeTag(raw: string): string {
	return raw
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
}

function defaultContainerTag(): string {
	return sanitizeTag(`openclaw_${hostname()}`)
}

export function parseConfig(raw: unknown): SupermemoryConfig {
	const cfg =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}

	if (Object.keys(cfg).length > 0) {
		assertAllowedKeys(cfg, ALLOWED_KEYS, "supermemory config")
	}

	let apiKey: string | undefined
	try {
		apiKey =
			typeof cfg.apiKey === "string" && cfg.apiKey.length > 0
				? resolveEnvVars(cfg.apiKey)
				: process.env.SUPERMEMORY_OPENCLAW_API_KEY
	} catch {
		apiKey = undefined
	}

	const customContainers: CustomContainer[] = []
	if (Array.isArray(cfg.customContainers)) {
		for (const c of cfg.customContainers) {
			if (
				c &&
				typeof c === "object" &&
				typeof (c as Record<string, unknown>).tag === "string" &&
				typeof (c as Record<string, unknown>).description === "string"
			) {
				customContainers.push({
					tag: sanitizeTag((c as Record<string, unknown>).tag as string),
					description: (c as Record<string, unknown>).description as string,
				})
			}
		}
	}

	return {
		apiKey,
		containerTag: cfg.containerTag
			? sanitizeTag(cfg.containerTag as string)
			: defaultContainerTag(),
		autoRecall: (cfg.autoRecall as boolean) ?? true,
		autoCapture: (cfg.autoCapture as boolean) ?? true,
		maxRecallResults: (cfg.maxRecallResults as number) ?? 10,
		profileFrequency: (cfg.profileFrequency as number) ?? 50,
		profileCacheTtlMs: (cfg.profileCacheTtlMs as number) ?? 300_000,
		postCompactThreshold: (cfg.postCompactThreshold as number) ?? 0.6,
		v4FetchTimeoutMs: (cfg.v4FetchTimeoutMs as number) ?? 10_000,
		captureMode:
			cfg.captureMode === "everything"
				? ("everything" as const)
				: ("all" as const),
		entityContext:
			typeof cfg.entityContext === "string" && cfg.entityContext.trim()
				? cfg.entityContext.trim()
				: DEFAULT_ENTITY_CONTEXT,
		debug: (cfg.debug as boolean) ?? false,
		enableCustomContainerTags:
			(cfg.enableCustomContainerTags as boolean) ?? false,
		customContainers,
		customContainerInstructions:
			typeof cfg.customContainerInstructions === "string"
				? cfg.customContainerInstructions
				: "",
		filterPrompt:
			typeof cfg.filterPrompt === "string" && cfg.filterPrompt.trim()
				? cfg.filterPrompt.trim()
				: undefined,
		// Default shouldLLMFilter to true when filterPrompt is set
		shouldLLMFilter:
			typeof cfg.shouldLLMFilter === "boolean"
				? cfg.shouldLLMFilter
				: typeof cfg.filterPrompt === "string" && cfg.filterPrompt.trim()
					? true
					: undefined,
		contextEngine: (cfg.contextEngine as boolean) ?? false,
		compactKeepLast: (cfg.compactKeepLast as number) ?? 10,
		assembleThreshold: (cfg.assembleThreshold as number) ?? 0.7,
		useConversationsApi: (cfg.useConversationsApi as boolean) ?? true,
		ingestDebounceCount: (cfg.ingestDebounceCount as number) ?? 1,
	}
}

export const supermemoryConfigSchema = {
	jsonSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			apiKey: { type: "string" },
			containerTag: { type: "string" },
			autoRecall: { type: "boolean" },
			autoCapture: { type: "boolean" },
			maxRecallResults: { type: "number" },
			profileFrequency: { type: "number" },
			profileCacheTtlMs: { type: "number" },
			postCompactThreshold: { type: "number" },
			v4FetchTimeoutMs: { type: "number" },
			captureMode: { type: "string", enum: ["all", "everything"] },
			entityContext: { type: "string" },
			debug: { type: "boolean" },
			enableCustomContainerTags: { type: "boolean" },
			customContainers: {
				type: "array",
				items: {
					type: "object",
					properties: {
						tag: { type: "string" },
						description: { type: "string" },
					},
					required: ["tag", "description"],
				},
			},
			customContainerInstructions: { type: "string" },
			filterPrompt: { type: "string" },
			shouldLLMFilter: { type: "boolean" },
			contextEngine: { type: "boolean" },
			compactKeepLast: { type: "number", minimum: 1, maximum: 50 },
			assembleThreshold: { type: "number", minimum: 0, maximum: 1 },
			useConversationsApi: { type: "boolean" },
			ingestDebounceCount: { type: "number", minimum: 1, maximum: 10 },
		},
	},
	parse: parseConfig,
}
