/**
 * Standalone Linear gateway — entry point.
 *
 * Usage:
 *   npx tsx src/standalone/index.ts [--config <path>] [--port <number>]
 *
 * Defaults:
 *   --config  ~/.linear-gateway/config.json
 *   --port    8091 (or value from config file / LINEAR_GATEWAY_PORT)
 */

import { LinearAgentApi, resolveLinearToken } from "../core/linear-client.js"
import { createConsoleLogger } from "../core/logger.js"
import { FileTokenStore } from "./token-store.js"
import { loadConfig } from "./config.js"
import { createGatewayServer } from "./server.js"

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { configPath?: string; port?: number } {
  const args = { configPath: undefined as string | undefined, port: undefined as number | undefined }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) {
      args.configPath = argv[++i]
    } else if (argv[i] === "--port" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10)
      if (!Number.isNaN(n)) args.port = n
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: npx tsx src/standalone/index.ts [--config <path>] [--port <number>]")
      process.exit(0)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const log = createConsoleLogger("linear-gateway")

  // Load config
  let config
  try {
    config = loadConfig(args.configPath)
  } catch (err) {
    console.error(`[linear-gateway] config error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
    return
  }

  // CLI --port overrides everything
  const port = args.port || config.port

  // Create token store
  const tokenStore = new FileTokenStore(config.tokenStorePath!)
  log.info(`token store: ${tokenStore.getPath()}`)

  // Resolve Linear token (for LinearAgentApi if needed)
  const tokenInfo = resolveLinearToken(undefined, tokenStore)
  if (!tokenInfo.accessToken) {
    log.warn("no Linear access token found — API calls will fail until OAuth is completed")
  } else {
    log.info(`Linear token source: ${tokenInfo.source}`)
  }

  // Create LinearAgentApi instance for emitActivity and CLI use
  let linearApi: LinearAgentApi | null = null
  if (tokenInfo.accessToken) {
    linearApi = new LinearAgentApi(tokenInfo.accessToken, {
      refreshToken: tokenInfo.refreshToken,
      expiresAt: tokenInfo.expiresAt,
      clientId: process.env.LINEAR_CLIENT_ID,
      clientSecret: process.env.LINEAR_CLIENT_SECRET,
      tokenStore,
    })
    log.info("LinearAgentApi initialized")
  } else {
    log.warn("no Linear token — emitActivity disabled, CLI will also fail")
  }

  // Create and start server
  const server = createGatewayServer(config, linearApi)

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      log.error(`server error: ${err.message}`)
      reject(err)
    })

    server.listen(port, () => {
      log.info(`listening on port ${port}`)
      log.info(`config: ${args.configPath || "default (~/.linear-gateway/config.json)"}`)
      log.info(`hermes: ${config.hermes.webhookUrl}`)
      resolve()
    })
  })

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`)
    server.close(() => {
      log.info("server closed")
      process.exit(0)
    })
    // Force exit after 5s if server doesn't close cleanly
    setTimeout(() => process.exit(1), 5000)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((err) => {
  console.error(`[linear-gateway] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
