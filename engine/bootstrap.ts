import type { BootstrapResult } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { setProfileCache } from "../hooks/recall.ts"
import { log } from "../logger.ts"

/**
 * Build the bootstrap() handler for the context engine.
 *
 * Called once when the engine first sees a session (when sessionFile exists).
 * NOTE: bootstrap() is NOT called on brand-new sessions (hadSessionFile=false).
 * First assemble() must handle cold cache gracefully.
 */
export function buildBootstrapHandler(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
) {
	return async (_params: {
		sessionId: string
		sessionKey?: string
		sessionFile: string
	}): Promise<BootstrapResult> => {
		try {
			// Warm profile cache (fire-and-forget pattern, but await here since
			// bootstrap is not on the critical path)
			const profile = await client.getProfile(undefined)
			setProfileCache(profile, cfg.profileCacheTtlMs)
			log.info("CE bootstrap: profile cache warmed")

			return { bootstrapped: true }
		} catch (err) {
			// Runtime also catches bootstrap errors, but handle gracefully
			log.warn(`CE bootstrap: failed — ${err instanceof Error ? err.message : String(err)}`)
			return { bootstrapped: false, reason: "profile warmup failed" }
		}
	}
}
