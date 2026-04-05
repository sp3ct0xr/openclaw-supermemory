import fs from "node:fs"
import path from "node:path"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { log } from "./logger.ts"

let workspaceDir: string | undefined
let allowedDirs: string[] = []
let initialized = false

/**
 * Initialize the path guard. Call once at plugin registration time.
 * Resolves workspace from OpenClaw SDK, with fallback paths.
 * Adds /tmp as an additional safe directory for downloaded files.
 */
export function initPathGuard(api: OpenClawPluginApi): void {
	if (initialized) return

	// Resolve workspace via OpenClaw SDK
	try {
		// SDK signature: api.runtime.agent.resolveAgentWorkspaceDir(cfg)
		// TODO: remove `as any` casts when OpenClaw plugin SDK types expose `config` and `runtime`
		const cfg = (api as any).config ?? api.pluginConfig
		const runtime = (api as any).runtime
		const raw = runtime?.agent?.resolveAgentWorkspaceDir?.(cfg)
		workspaceDir = raw ? fs.realpathSync(raw) : undefined
	} catch (err) {
		log.warn(`path-guard: SDK workspace resolution failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	// Fallback: try known OpenClaw workspace paths (no cwd — too broad)
	if (!workspaceDir) {
		const fallbackPaths = [
			"/data/.openclaw/workspace",
			process.env.OPENCLAW_WORKSPACE_DIR,
		].filter(Boolean) as string[]
		for (const candidate of fallbackPaths) {
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
					workspaceDir = fs.realpathSync(candidate)
					log.info(`path-guard: workspaceDir resolved via fallback: ${workspaceDir}`)
					break
				}
			} catch { /* skip invalid candidate */ }
		}
	}

	// Build allowed directories list, resolving symlinks (e.g. /tmp → /private/tmp on macOS)
	const rawAllowedDirs = [workspaceDir, "/tmp"].filter(Boolean) as string[]
	allowedDirs = [...new Set(rawAllowedDirs.flatMap((dir) => {
		try {
			return [fs.realpathSync(dir)]
		} catch {
			log.warn(`path-guard: skipping allowed dir ${dir} (realpath failed)`)
			return []
		}
	}))]

	log.info(`path-guard: workspaceDir=${workspaceDir ?? "(undefined)"} allowedDirs=[${allowedDirs.join(", ")}]`)
	initialized = true
}

/**
 * Check if a file path is inside an allowed directory.
 * Resolves symlinks via realpathSync before checking.
 * Returns true if the path is safe to read, false otherwise.
 */
export function isAllowedPath(filePath: string): boolean {
	if (allowedDirs.length === 0) {
		log.warn("path-guard: no allowed directories configured — denying file read")
		return false
	}
	try {
		// NOTE: realpathSync throws ENOENT for non-existent files → catch returns false
		// → caller sees "Access denied" instead of "File not found". This is intentional:
		// prevents existence probing of out-of-boundary paths.
		const resolved = fs.realpathSync(filePath)
		for (const dir of allowedDirs) {
			if (resolved === dir) return true
			const rel = path.relative(dir, resolved)
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true
		}
		log.warn(`path-guard: REJECTED ${resolved} — not inside [${allowedDirs.join(", ")}]`)
		return false
	} catch (err) {
		log.warn(`path-guard: realpathSync failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
		return false
	}
}

/** Get the resolved workspace directory (for logging). */
export function getWorkspaceDir(): string | undefined {
	return workspaceDir
}
