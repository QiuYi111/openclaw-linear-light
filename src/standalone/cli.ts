#!/usr/bin/env node

/**
 * Linear CLI — thin wrapper around LinearAgentApi for Hermes agent use.
 *
 * Usage:
 *   linear comment <issue-id> <body>
 *   linear status <issue-id> <state-name>
 *   linear emit <agent-session-id> <body>
 *   linear get <issue-id>
 *   linear search <query>
 *
 * Reads token from ~/.linear-gateway/token.json or LINEAR_API_TOKEN env var.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LinearAgentApi, resolveLinearToken } from "../core/linear-client.js"
import { FileTokenStore } from "./token-store.js"
import { runWatchdog, type WatchdogOptions } from "./watchdog.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApi(): LinearAgentApi {
  // 1. Try token store (OAuth)
  const tokenStorePath = process.env.LINEAR_TOKEN_STORE_PATH || join(homedir(), ".linear-gateway", "token.json")
  const tokenStore = new FileTokenStore(tokenStorePath)
  const tokenInfo = resolveLinearToken(undefined, tokenStore)

  if (tokenInfo.accessToken) {
    return new LinearAgentApi(tokenInfo.accessToken, {
      refreshToken: tokenInfo.refreshToken,
      expiresAt: tokenInfo.expiresAt,
      clientId: process.env.LINEAR_CLIENT_ID,
      clientSecret: process.env.LINEAR_CLIENT_SECRET,
      tokenStore,
    })
  }

  // 2. Try LINEAR_API_TOKEN env var (Personal API Key)
  const apiKey = process.env.LINEAR_API_TOKEN
  if (apiKey) {
    return new LinearAgentApi(apiKey)
  }

  // 3. Try ~/.hermes/.env
  const envPath = join(homedir(), ".hermes", ".env")
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf8")
    const match = envContent.match(/^LINEAR_API_TOKEN=(.+)$/m)
    if (match?.[1]) {
      return new LinearAgentApi(match[1].trim())
    }
  }

  console.error("Error: no Linear token found. Set LINEAR_API_TOKEN or run OAuth flow.")
  process.exit(1)
}

function printUsage(): void {
  console.log(`Usage: linear <command> [args...]

Commands:
  comment <issue-id> <body>   Post a comment on an issue
  status <issue-id> <state>   Update issue status (e.g. "In Progress", "Done")
  emit <session-id> <body>    Emit activity to an agent session
  get <issue-id>              Get issue details (JSON)
  search <query>              Search issues (JSON)
  watchdog [--port N] [--fix] [--json]
                              Health-check the gateway (token, network, process)`)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdComment(api: LinearAgentApi, args: string[]): Promise<void> {
  const [issueId, ...rest] = args
  if (!issueId || rest.length === 0) {
    console.error("Usage: linear comment <issue-id> <body>")
    process.exit(1)
  }
  const body = rest.join(" ")
  const commentId = await api.createComment(issueId, body)
  console.log(JSON.stringify({ success: true, commentId }))
}

async function cmdStatus(api: LinearAgentApi, args: string[]): Promise<void> {
  const [issueId, stateName] = args
  if (!(issueId && stateName)) {
    console.error("Usage: linear status <issue-id> <state-name>")
    process.exit(1)
  }
  const success = await api.updateIssueState(issueId, stateName)
  console.log(JSON.stringify({ success }))
}

async function cmdEmit(api: LinearAgentApi, args: string[]): Promise<void> {
  const [sessionId, ...rest] = args
  if (!sessionId || rest.length === 0) {
    console.error("Usage: linear emit <agent-session-id> <body>")
    process.exit(1)
  }
  const body = rest.join(" ")
  await api.emitActivity(sessionId, { type: "response", body })
  console.log(JSON.stringify({ success: true }))
}

async function cmdGet(api: LinearAgentApi, args: string[]): Promise<void> {
  const [issueId] = args
  if (!issueId) {
    console.error("Usage: linear get <issue-id>")
    process.exit(1)
  }
  const issue = await api.getIssueDetails(issueId)
  console.log(JSON.stringify(issue, null, 2))
}

async function cmdSearch(api: LinearAgentApi, args: string[]): Promise<void> {
  const query = args.join(" ")
  if (!query) {
    console.error("Usage: linear search <query>")
    process.exit(1)
  }
  const data = await api.gql<{
    issueSearch: {
      nodes: Array<{ id: string; identifier: string; title: string; state: { name: string }; url: string }>
    }
  }>(
    `query($query: String!, $first: Int) {
      issueSearch(query: $query, first: $first) {
        nodes { id identifier title state { name } url }
      }
    }`,
    { query, first: 20 },
  )
  console.log(JSON.stringify(data.issueSearch.nodes, null, 2))
}

async function cmdWatchdog(args: string[]): Promise<void> {
  const opts: WatchdogOptions = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      opts.port = Number.parseInt(args[++i], 10)
    } else if (args[i] === "--fix") {
      opts.fix = true
    } else if (args[i] === "--json") {
      opts.json = true
    } else if (args[i] === "--token-store" && args[i + 1]) {
      opts.tokenStorePath = args[++i]
    }
  }

  const report = await runWatchdog(opts)

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const status = report.healthy ? "✅ healthy" : "❌ unhealthy"
    console.log(`[${new Date().toISOString()}] ${status}`)
    for (const check of report.checks) {
      const icon = check.ok ? "✓" : "✗"
      const repair = check.repaired ? " [REPAIRED]" : ""
      console.log(`  ${icon} ${check.name}: ${check.detail ?? "ok"}${repair}`)
    }
  }

  process.exit(report.healthy ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv

  if (!command || command === "help" || command === "-h") {
    printUsage()
    process.exit(command ? 0 : 1)
  }

  const api = resolveApi()

  switch (command) {
    case "comment":
      await cmdComment(api, args)
      break
    case "status":
      await cmdStatus(api, args)
      break
    case "emit":
      await cmdEmit(api, args)
      break
    case "get":
      await cmdGet(api, args)
      break
    case "search":
      await cmdSearch(api, args)
      break
    case "watchdog":
      await cmdWatchdog(args)
      return // watchdog handles its own exit code
    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
