/**
 * Standalone config loading for Linear gateway.
 *
 * Loads from a JSON config file, with environment variable overrides.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StandaloneConfig {
  port: number
  linear: {
    webhookSecret: string
    clientId: string
    clientSecret: string
  }
  hermes: {
    webhookUrl: string
    routeSecret: string
    timeoutMs?: number
  }
  botUserId?: string
  autoInProgress?: boolean
  /** State types that are considered terminal — agent won't dispatch if issue is in these states. */
  terminalStateTypes?: string[]
  tokenStorePath?: string
  logLevel?: "debug" | "info" | "warn" | "error"
  /** Trigger word for Comment.create fallback (case-insensitive substring match). Default: "Linus" */
  mentionTrigger?: string
  /** Custom agent identity injected into prompts. Falls back to built-in default. */
  agentIdentity?: string
  /** Enable project memory context injection (read AGENTS.md, Context.md, etc.). Default: true */
  projectMemoryEnabled?: boolean
  /** Template for initial response activity. {identifier} and {title} are replaced. */
  initialResponseTemplate?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = join(homedir(), ".linear-gateway", "config.json")
const DEFAULT_TOKEN_STORE_PATH = join(homedir(), ".linear-gateway", "token.json")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(key: string): string | undefined {
  return process.env[key]
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v == null) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load standalone config from a JSON file, with environment variable overrides.
 *
 * Priority (highest → lowest):
 *   1. Environment variables
 *   2. JSON config file values
 *   3. Hard-coded defaults
 */
export function loadConfig(configPath?: string): StandaloneConfig {
  const path = configPath || DEFAULT_CONFIG_PATH

  // Read JSON config file (optional — env-only mode is supported)
  let fileConfig: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8")
      fileConfig = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new Error(`Failed to parse config file at ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const linear = (fileConfig.linear || {}) as Record<string, unknown>
  const hermes = (fileConfig.hermes || {}) as Record<string, unknown>

  const config: StandaloneConfig = {
    port: envInt("LINEAR_GATEWAY_PORT", (linear.port as number) || 8091),

    linear: {
      webhookSecret: env("LINEAR_WEBHOOK_SECRET") || (linear.webhookSecret as string) || "",
      clientId: env("LINEAR_CLIENT_ID") || (linear.clientId as string) || "",
      clientSecret: env("LINEAR_CLIENT_SECRET") || (linear.clientSecret as string) || "",
    },

    hermes: {
      webhookUrl: env("HERMES_WEBHOOK_URL") || (hermes.webhookUrl as string) || "",
      routeSecret: env("HERMES_ROUTE_SECRET") || (hermes.routeSecret as string) || "",
      timeoutMs: envInt("HERMES_TIMEOUT_MS", (hermes.timeoutMs as number) || 30000),
    },

    tokenStorePath: (fileConfig.tokenStorePath as string) || DEFAULT_TOKEN_STORE_PATH,

    botUserId: (fileConfig.botUserId as string) || env("LINEAR_BOT_USER_ID") || "",
    autoInProgress: (fileConfig.autoInProgress as boolean) ?? true,
    terminalStateTypes: (fileConfig.terminalStateTypes as string[]) || ["completed", "canceled"],

    mentionTrigger: (fileConfig.mentionTrigger as string) || "Linus",
    agentIdentity: (fileConfig.agentIdentity as string) || undefined,
    projectMemoryEnabled: (fileConfig.projectMemoryEnabled as boolean) ?? true,
    initialResponseTemplate: (fileConfig.initialResponseTemplate as string) || undefined,

    logLevel: (fileConfig.logLevel as StandaloneConfig["logLevel"]) || "info",
  }

  // Validate required fields
  const missing: string[] = []
  if (!config.linear.webhookSecret) missing.push("linear.webhookSecret (or LINEAR_WEBHOOK_SECRET)")
  if (!config.hermes.webhookUrl) missing.push("hermes.webhookUrl (or HERMES_WEBHOOK_URL)")
  if (!config.hermes.routeSecret) missing.push("hermes.routeSecret (or HERMES_ROUTE_SECRET)")

  if (missing.length > 0) {
    throw new Error(`Missing required config:\n  ${missing.join("\n  ")}\n\nConfig file: ${path}`)
  }

  return config
}
