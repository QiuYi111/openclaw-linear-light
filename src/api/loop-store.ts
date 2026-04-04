/**
 * Persistent storage for completion loop state.
 *
 * Stores active loop metadata in ~/.openclaw/plugins/linear-light/completion-loops.json
 * using atomic write-then-rename to prevent corruption.
 *
 * On gateway restart, persisted loops can be reloaded and resumed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Logger } from "./linear-api.js"

const LOOP_DIR = join(homedir(), ".openclaw", "plugins", "linear-light")
const LOOP_PATH = join(LOOP_DIR, "completion-loops.json")

// ---------------------------------------------------------------------------
// Logger injection
// ---------------------------------------------------------------------------

let _logger: Logger = console as unknown as Logger

export function setLoopStoreLogger(logger: Logger): void {
  _logger = logger
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loop metadata safe for JSON serialization (no timer). */
export interface PersistedLoop {
  issueId: string
  issueIdentifier: string
  sessionKey: string
  iterations: number
  startedAt: number
}

/** Internal map type matching the JSON file structure. */
export type PersistedLoopMap = Record<string, PersistedLoop>

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read persisted loop state from disk.
 * Returns an empty object if the file doesn't exist or is corrupt.
 */
export function readPersistedLoops(): PersistedLoopMap {
  try {
    if (!existsSync(LOOP_PATH)) return {}
    const raw = readFileSync(LOOP_PATH, "utf8")
    const data = JSON.parse(raw)
    if (typeof data !== "object" || data === null) return {}
    return data as PersistedLoopMap
  } catch {
    return {}
  }
}

/**
 * Write persisted loop state to disk using atomic write-then-rename.
 * Pass the full map — callers are responsible for building it.
 */
export function writePersistedLoops(loops: PersistedLoopMap): void {
  try {
    if (!existsSync(LOOP_DIR)) {
      mkdirSync(LOOP_DIR, { recursive: true, mode: 0o700 })
    }

    const tmpPath = `${LOOP_PATH}.tmp`
    writeFileSync(tmpPath, JSON.stringify(loops, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpPath, LOOP_PATH)
  } catch (err) {
    _logger.error(`[Linear Light] failed to write loop store: ${err}`)
  }
}
