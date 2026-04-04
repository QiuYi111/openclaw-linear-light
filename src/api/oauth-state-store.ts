/**
 * Disk-backed PKCE state storage.
 *
 * Persists in-flight OAuth states to ~/.openclaw/plugins/linear-light/oauth-states.json
 * so they survive process restarts between /oauth/init and /oauth/callback.
 *
 * Uses atomic write-then-rename to prevent corruption (same pattern as oauth-store.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Logger } from "./linear-api.js"

const TOKEN_DIR = join(homedir(), ".openclaw", "plugins", "linear-light")
const STATE_PATH = join(TOKEN_DIR, "oauth-states.json")

// ---------------------------------------------------------------------------
// Logger injection
// ---------------------------------------------------------------------------

let _logger: Logger = console as unknown as Logger

export function setOauthStateStoreLogger(logger: Logger): void {
  _logger = logger
}

export interface PendingState {
  codeVerifier: string
  redirectUri: string
  expiresAt: number
}

type StateMap = Record<string, PendingState>

/**
 * Read all pending states from disk, cleaning up expired entries.
 * Returns null if the file doesn't exist or is invalid.
 */
export function readPendingStates(): StateMap | null {
  try {
    if (!existsSync(STATE_PATH)) return null
    const raw = readFileSync(STATE_PATH, "utf8")
    const states = JSON.parse(raw) as StateMap
    const now = Date.now()
    let cleaned = false
    for (const [key, val] of Object.entries(states)) {
      if (now > val.expiresAt) {
        delete states[key]
        cleaned = true
      }
    }
    // Persist cleanup back to disk if we removed expired entries
    if (cleaned) {
      writeStateFileSync(states)
    }
    return states
  } catch {
    return null
  }
}

/**
 * Get a single pending state by key. Returns null if not found or expired.
 */
export function getPendingState(state: string): PendingState | null {
  const states = readPendingStates()
  return states?.[state] ?? null
}

/**
 * Save a pending state to disk.
 */
export function savePendingState(state: string, data: PendingState): void {
  const states = readPendingStates() || {}
  states[state] = data
  writeStateFileSync(states)
}

/**
 * Delete a pending state from disk.
 */
export function deletePendingState(state: string): void {
  const states = readPendingStates()
  if (!(states && state in states)) return
  delete states[state]
  writeStateFileSync(states)
}

/**
 * Internal: write state map to disk using atomic write-then-rename.
 */
function writeStateFileSync(states: StateMap): void {
  try {
    if (!existsSync(TOKEN_DIR)) {
      mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 })
    }
    const tmpPath = `${STATE_PATH}.tmp`
    writeFileSync(tmpPath, JSON.stringify(states, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpPath, STATE_PATH)
  } catch (err) {
    _logger.error(`Linear Light: failed to write oauth state store: ${err}`)
  }
}
