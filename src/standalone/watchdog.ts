/**
 * Linear Gateway Watchdog — health check + auto-repair for standalone gateway.
 *
 * Checks three failure modes:
 *   1. Token validity (GraphQL viewer query)
 *   2. Gateway process (HTTP health endpoint)
 *   3. Network connectivity (can reach Linear API at all)
 *
 * Designed to be called from cron or systemd timer. Exits 0 when healthy,
 * exits 1 when unhealthy (after attempting repair).
 *
 * Usage:
 *   linear watchdog [--port 8091] [--fix] [--json]
 */

import { resolveLinearToken } from "../core/linear-client.js"
import { FileTokenStore } from "./token-store.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** Gateway HTTP port (default: 8091) */
  port?: number
  /** Attempt auto-repair on failure */
  fix?: boolean
  /** Output results as JSON */
  json?: boolean
  /** Token store path override */
  tokenStorePath?: string
}

export type CheckResult = {
  name: string
  ok: boolean
  detail?: string
  repaired?: boolean
}

export interface WatchdogReport {
  timestamp: string
  checks: CheckResult[]
  healthy: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 8091
const GATEWAY_TIMEOUT_MS = 5000
const API_TIMEOUT_MS = 10000

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

/**
 * Check 1: Can we reach the Linear GraphQL API at all?
 * Distinguishes "network is broken" from "token is expired".
 */
async function checkNetworkConnectivity(): Promise<CheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    // 401 is fine — it means we can reach the API, just not authenticated
    if (res.status === 401 || res.status === 200) {
      return { name: "network", ok: true, detail: `HTTP ${res.status}` }
    }
    return { name: "network", ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    return { name: "network", ok: false, detail: msg }
  }
}

/**
 * Check 2: Can we authenticate with the current token?
 * Uses a lightweight viewer query.
 */
async function checkTokenValidity(tokenStorePath: string): Promise<CheckResult> {
  const tokenStore = new FileTokenStore(tokenStorePath)
  const tokenInfo = resolveLinearToken(undefined, tokenStore)

  if (!tokenInfo.accessToken) {
    return { name: "token", ok: false, detail: "no token found in store" }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: tokenInfo.refreshToken ? `Bearer ${tokenInfo.accessToken}` : tokenInfo.accessToken,
      },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (res.ok) {
      const payload = (await res.json()) as { data?: { viewer?: { id: string; name: string } } }
      if (payload.data?.viewer?.id) {
        return { name: "token", ok: true, detail: `viewer: ${payload.data.viewer.name}` }
      }
      return { name: "token", ok: false, detail: "viewer query returned no data" }
    }

    return { name: "token", ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { name: "token", ok: false, detail: msg }
  }
}

/**
 * Check 3: Is the gateway process responding on its health endpoint?
 */
async function checkGatewayHealth(port: number): Promise<CheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (res.ok) {
      const payload = (await res.json()) as { status?: string; uptime?: number }
      return {
        name: "gateway",
        ok: true,
        detail: `uptime: ${payload.uptime ?? "unknown"}s`,
      }
    }
    return { name: "gateway", ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    return { name: "gateway", ok: false, detail: msg }
  }
}

// ---------------------------------------------------------------------------
// Auto-repair
// ---------------------------------------------------------------------------

async function attemptRepair(checks: CheckResult[]): Promise<void> {
  for (const check of checks) {
    if (check.ok) continue

    // Gateway is down — try pm2 restart
    if (check.name === "gateway") {
      const { execSync } = await import("node:child_process")
      try {
        execSync("pm2 restart linear-gateway", { timeout: 15000, stdio: "pipe" })
        check.repaired = true
        check.detail += " [restarted via pm2]"
      } catch {
        check.detail += " [pm2 restart failed]"
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runWatchdog(opts: WatchdogOptions): Promise<WatchdogReport> {
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const port = opts.port ?? DEFAULT_PORT
  const tokenStorePath = opts.tokenStorePath ?? join(homedir(), ".linear-gateway", "token.json")

  const checks: CheckResult[] = []

  // Run checks in order — network first (fastest failure signal)
  checks.push(await checkNetworkConnectivity())
  if (!checks[0].ok) {
    // Network is down — skip token and gateway checks
    const report: WatchdogReport = {
      timestamp: new Date().toISOString(),
      checks,
      healthy: false,
    }
    if (opts.fix) await attemptRepair(checks)
    return report
  }

  checks.push(await checkTokenValidity(tokenStorePath))
  checks.push(await checkGatewayHealth(port))

  const healthy = checks.every((c) => c.ok)

  if (!healthy && opts.fix) {
    await attemptRepair(checks)
  }

  return {
    timestamp: new Date().toISOString(),
    checks,
    healthy,
  }
}
