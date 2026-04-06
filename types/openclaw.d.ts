declare module "openclaw/plugin-sdk" {
	export interface OpenClawPluginApi {
		pluginConfig: unknown
		logger: {
			info: (msg: string) => void
			warn: (msg: string) => void
			error: (msg: string, ...args: unknown[]) => void
			debug: (msg: string) => void
		}
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerTool(tool: any, options: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerCommand(command: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerCli(handler: any, options?: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerService(service: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		on(event: string, handler: (...args: any[]) => any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerMemoryRuntime?(runtime: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerMemoryPromptSection?(builder: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship types
		registerMemoryFlushPlan?(resolver: any): void
		/** Register a context engine plugin. Engine ID must match plugins.slots.contextEngine in config. */
		registerContextEngine?(id: string, factory: ContextEngineFactory): void
	}

	/** Factory that creates a ContextEngine instance. */
	export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>

	// ── Context Engine types (from openclaw/src/context-engine/types.ts) ──

	/** Message type used by OpenClaw runtime */
	export type AgentMessage = {
		role: string
		content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
		[key: string]: unknown
	}

	export type ContextEngineInfo = {
		id: string
		name: string
		version?: string
		/** True when the engine manages its own compaction lifecycle. */
		ownsCompaction?: boolean
	}

	export type AssembleResult = {
		messages: AgentMessage[]
		estimatedTokens: number
		systemPromptAddition?: string
	}

	export type CompactResult = {
		ok: boolean
		compacted: boolean
		reason?: string
		result?: {
			summary?: string
			firstKeptEntryId?: string
			tokensBefore: number
			tokensAfter?: number
			details?: unknown
		}
	}

	export type IngestResult = {
		ingested: boolean
	}

	export type IngestBatchResult = {
		ingestedCount: number
	}

	export type BootstrapResult = {
		bootstrapped: boolean
		importedMessages?: number
		reason?: string
	}

	export type ContextEngineRuntimeContext = Record<string, unknown>

	/** The pluggable contract for context management. */
	export interface ContextEngine {
		readonly info: ContextEngineInfo

		bootstrap?(params: {
			sessionId: string
			sessionKey?: string
			sessionFile: string
		}): Promise<BootstrapResult>

		ingest(params: {
			sessionId: string
			sessionKey?: string
			message: AgentMessage
			isHeartbeat?: boolean
		}): Promise<IngestResult>

		ingestBatch?(params: {
			sessionId: string
			sessionKey?: string
			messages: AgentMessage[]
			isHeartbeat?: boolean
		}): Promise<IngestBatchResult>

		afterTurn?(params: {
			sessionId: string
			sessionKey?: string
			sessionFile: string
			messages: AgentMessage[]
			prePromptMessageCount: number
			autoCompactionSummary?: string
			isHeartbeat?: boolean
			tokenBudget?: number
			runtimeContext?: ContextEngineRuntimeContext
		}): Promise<void>

		assemble(params: {
			sessionId: string
			sessionKey?: string
			messages: AgentMessage[]
			tokenBudget?: number
			model?: string
			prompt?: string
		}): Promise<AssembleResult>

		compact(params: {
			sessionId: string
			sessionKey?: string
			sessionFile: string
			tokenBudget?: number
			force?: boolean
			currentTokenCount?: number
			compactionTarget?: "budget" | "threshold"
			customInstructions?: string
			runtimeContext?: ContextEngineRuntimeContext
		}): Promise<CompactResult>

		dispose?(): Promise<void>
	}

	/** Delegate compaction to OpenClaw's built-in runtime compaction path (legacy engine). */
	export function delegateCompactionToRuntime(params: {
		sessionId: string
		sessionKey?: string
		sessionFile: string
		tokenBudget?: number
		force?: boolean
		currentTokenCount?: number
		compactionTarget?: "budget" | "threshold"
		customInstructions?: string
		runtimeContext?: Record<string, unknown>
	}): Promise<CompactResult>
}
