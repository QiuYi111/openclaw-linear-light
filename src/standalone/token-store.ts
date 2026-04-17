/**
 * Filesystem-backed TokenStore for standalone mode.
 *
 * Implements the TokenStore interface from core/linear-client.ts using a
 * JSON file at a configurable path (default ~/.linear-gateway/token.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { StoredToken, TokenStore } from "../core/linear-client.js"

// ---------------------------------------------------------------------------
// FileTokenStore
// ---------------------------------------------------------------------------

export class FileTokenStore implements TokenStore {
  private path: string

  constructor(path: string) {
    this.path = path
    this.ensureDir()
  }

  read(): StoredToken | null {
    try {
      if (!existsSync(this.path)) return null
      const raw = readFileSync(this.path, "utf8")
      const data = JSON.parse(raw) as StoredToken
      // Basic shape validation
      if (!data.accessToken) return null
      return data
    } catch {
      return null
    }
  }

  write(token: StoredToken): void {
    this.ensureDir()
    try {
      writeFileSync(this.path, JSON.stringify(token, null, 2), "utf8")
    } catch (err) {
      console.error(`[FileTokenStore] failed to write token: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Get the file path (useful for diagnostics) */
  getPath(): string {
    return this.path
  }

  private ensureDir(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}
