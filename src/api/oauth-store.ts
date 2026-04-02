/**
 * Plugin-local OAuth token storage.
 *
 * Reads/writes tokens from ~/.openclaw/plugins/linear-light/token.json
 * using atomic write-then-rename to prevent corruption.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TOKEN_DIR = join(homedir(), ".openclaw", "plugins", "linear-light")
const TOKEN_PATH = join(TOKEN_DIR, "token.json")

export interface StoredToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/**
 * Read OAuth tokens from plugin-local storage.
 * Returns null if no token file exists or is invalid.
 */
export function readStoredToken(): StoredToken | null {
  try {
    if (!existsSync(TOKEN_PATH)) return null
    const raw = readFileSync(TOKEN_PATH, "utf8")
    const data = JSON.parse(raw) as StoredToken
    if (!data.accessToken) return null
    return data
  } catch {
    return null
  }
}

/**
 * Write OAuth tokens to plugin-local storage using atomic write-then-rename.
 */
export function writeStoredToken(token: StoredToken): void {
  try {
    if (!existsSync(TOKEN_DIR)) {
      mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 })
    }

    const tmpPath = `${TOKEN_PATH}.tmp`
    writeFileSync(tmpPath, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpPath, TOKEN_PATH)
  } catch (err) {
    console.error(`Linear Light: failed to write token store: ${err}`)
  }
}
