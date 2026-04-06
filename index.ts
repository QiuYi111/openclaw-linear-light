/**
 * Linear Channel Plugin for OpenClaw
 *
 * Linear as a first-class OpenClaw channel — every issue is a session.
 * Users get the full agent experience (all tools, skills, memory)
 * just like chatting on Telegram or Feishu.
 *
 * Architecture:
 * - Linear webhook → dispatchInboundReplyWithBase() → main agent → outbound.sendText() → createComment()
 * - Each issue = one OpenClaw session (agent:main:linear:issue:<identifier>)
 * - Agent replies automatically become Linear comments via outbound adapter
 * - Additional tools for Linear operations (update status, search, etc.)
 */

import type { AnyAgentTool, ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk"
import {
  onAfterToolCall,
  onAgentEnd,
  onBeforeToolCall,
  onLlmOutput,
  setActivityStreamLogger,
} from "./src/activity-stream.js"
import type { Logger } from "./src/api/linear-api.js"
import { LinearAgentApi, resolveLinearToken } from "./src/api/linear-api.js"
import { setLoopStoreLogger } from "./src/api/loop-store.js"
import { setOauthStateStoreLogger } from "./src/api/oauth-state-store.js"
import {
  resumePersistedLoops,
  setCompletionLoopConfig,
  setCompletionLoopDispatcher,
  setCompletionLoopLogger,
} from "./src/completion-loop.js"
import { validateConfig } from "./src/config-validation.js"
import { handleOAuthCallback, handleOAuthInit } from "./src/oauth-handler.js"
import { getLinearApi, setLinearApi, setLinearRuntime } from "./src/runtime.js"
import { dispatchCompletionPrompt, handleWebhook, setFallbackDispatchContext } from "./src/webhook-handler.js"

// ---------------------------------------------------------------------------
// Maps issueId → Linear agent session ID (for emitActivity)
// Maps issue identifier (e.g. "DEV-163") → Linear agent session ID (for activity stream hooks)
// Entries are cleaned up after agent_end + a short grace period for late activity.
// ---------------------------------------------------------------------------

const SESSION_CLEANUP_DELAY_MS = 30_000

export const agentSessionMap = new Map<string, string>()
export const identifierSessionMap = new Map<string, string>()

/** Schedule removal of session map entries after a grace period. */
export function scheduleSessionCleanup(issueId: string, identifier: string): void {
  setTimeout(() => {
    agentSessionMap.delete(issueId)
    identifierSessionMap.delete(identifier)
  }, SESSION_CLEANUP_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as Record<string, unknown> | undefined

  if (config?.enabled === false) {
    api.logger.info("Linear Light: disabled by config")
    return
  }

  // Store runtime for channel utilities access
  setLinearRuntime(api.runtime)

  // Inject logger into modules that don't receive api directly
  const pluginLogger = api.logger as unknown as Logger
  setActivityStreamLogger(pluginLogger)
  setLoopStoreLogger(pluginLogger)
  setOauthStateStoreLogger(pluginLogger)

  // Register OAuth routes (always available — needed for first token)
  api.registerHttpRoute({
    path: "/linear-light/oauth/callback",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleOAuthCallback(api, req, res)
    },
  })

  api.registerHttpRoute({
    path: "/linear-light/oauth/init",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleOAuthInit(api, req, res)
    },
  })

  // Health / status endpoint — always available (works even without a token)
  api.registerHttpRoute({
    path: "/linear-light/status",
    auth: "plugin",
    match: "exact",
    handler: async (_req, res) => {
      const validation = validateConfig(config)
      const tokenInfo = resolveLinearToken(config)

      const configured = {
        webhook: !!config?.webhookSecret,
        oauth: !!(config?.linearClientId && config?.linearClientSecret),
        token: !!tokenInfo.accessToken,
      }

      const status = validation.valid && configured.token ? "ok" : "degraded"

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          status,
          version: "0.1.0",
          configured,
          errors: validation.errors,
          warnings: validation.warnings,
        }),
      )
    },
  })

  // Log config validation results at startup
  const validation = validateConfig(config)
  for (const err of validation.errors) api.logger.error(`Linear Light: ${err}`)
  for (const warn of validation.warnings) api.logger.warn(`Linear Light: ${warn}`)

  const tokenInfo = resolveLinearToken(config)
  if (!tokenInfo.accessToken) {
    api.logger.warn("Linear Light: no access token. Visit /linear-light/oauth/init to start OAuth flow.")
    return
  }

  api.logger.info(`Linear Light: token source=${tokenInfo.source}, registering as channel...`)

  // Create shared LinearAgentApi singleton — reused by sendText, tools, and webhook handler
  const sharedLinearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
    logger: api.logger,
  })
  setLinearApi(sharedLinearApi)

  // Register webhook endpoint
  api.registerHttpRoute({
    path: "/linear-light/webhook",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleWebhook(api, req, res)
    },
  })

  // Register as a first-class channel — this is what makes deliver work
  api.registerChannel({ plugin: linearPlugin as ChannelPlugin })

  // Register Linear operation tools
  for (const tool of createLinearTools(api)) {
    api.registerTool(tool)
  }

  // Register lifecycle hooks for real-time activity streaming
  api.on("llm_output", onLlmOutput)
  // @ts-expect-error — hook param shape varies across openclaw versions
  api.on("before_tool_call", onBeforeToolCall)
  // @ts-expect-error — hook param shape varies across openclaw versions
  api.on("after_tool_call", onAfterToolCall)
  api.on("agent_end", onAgentEnd)

  // Set up completion loop (Ralph loop)
  setCompletionLoopConfig(config)
  setCompletionLoopLogger(api.logger)
  setFallbackDispatchContext(api, config)
  setCompletionLoopDispatcher((issueId, issueIdentifier, body) =>
    dispatchCompletionPrompt(issueId, issueIdentifier, body),
  )

  // Resume persisted loops from previous session
  resumePersistedLoops().then((count) => {
    if (count > 0) {
      api.logger.info(`Linear Light: resumed ${count} completion loop(s) from previous session`)
    }
  })

  api.logger.info("Linear Light: ready (channel mode)")
}

// ---------------------------------------------------------------------------
// Channel Plugin definition
// ---------------------------------------------------------------------------

const meta = {
  id: "linear" as const,
  label: "Linear",
  selectionLabel: "Linear Project Management",
  docsPath: "https://github.com/QiuYi111/openclaw-linear-light",
  blurb: "Manage Linear issues via OpenClaw agent",
  icon: null,
}

const linearPlugin: ChannelPlugin = {
  id: "linear",
  meta: {
    ...meta,
    quickstartAllowFrom: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: false,
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", configured: true }) as any,
    defaultAccountId: () => "default",
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text }) => {
      // `to` is the issue identifier (e.g. "DEV-134") from the session key
      // We need to resolve it to an issue UUID and post a comment
      const linearApi = getLinearApi()
      if (!linearApi) {
        return { channel: "linear", messageId: "", ok: false, error: "no access token" } as any
      }

      try {
        // `to` could be issue identifier (DEV-134) or issue UUID
        // We store the mapping in webhook-handler, but for outbound we need to resolve
        // For now, use the identifier to find the issue
        const issueId = await resolveIssueId(linearApi, to)
        if (!issueId) {
          return { channel: "linear", messageId: "", ok: false, error: `could not resolve issue: ${to}` } as any
        }

        const commentId = await linearApi.createComment(issueId, text)

        // Emit response activity for Linear's agent session UI
        const agentSessionId = agentSessionMap.get(issueId)
        if (agentSessionId) {
          try {
            await linearApi.emitActivity(agentSessionId, { type: "response", body: text })
          } catch {
            // Best-effort
          }
        }

        return { channel: "linear", messageId: commentId || "", ok: true } as any
      } catch (err) {
        return {
          channel: "linear",
          messageId: "",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as any
      }
    },
  },
}

// ---------------------------------------------------------------------------
// Resolve issue identifier or UUID to issue ID
// ---------------------------------------------------------------------------

async function resolveIssueId(linearApi: LinearAgentApi, idOrIdentifier: string): Promise<string | null> {
  // If it looks like a UUID, use directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrIdentifier)) {
    return idOrIdentifier
  }

  // Strip channel prefix (e.g. "linear:DEV-134" → "DEV-134")
  const identifier = idOrIdentifier.replace(/^[a-z]+:/, "")

  // Try to find by identifier (e.g. "DEV-134")
  try {
    const data = await linearApi.gql<{
      issue: { id: string } | null
    }>(
      `query IssueByIdentifier($identifier: String!) {
        issue(identifier: $identifier) { id }
      }`,
      { identifier },
    )
    return data.issue?.id ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tools — Linear operations
// ---------------------------------------------------------------------------

function createLinearTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const tokenInfo = resolveLinearToken(config)
  if (!tokenInfo.accessToken) return []

  const linearApi = getLinearApi()!

  return [
    {
      name: "linear_update_status",
      label: "Linear Update Status",
      description: "Update the status of a Linear issue (e.g. 'In Progress', 'Done', 'Todo', 'Canceled').",
      parameters: {
        type: "object" as const,
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
          status: { type: "string", description: "Target status name" },
        },
        required: ["issueId", "status"],
      },
      execute: async (_tc: string, { issueId, status }: { issueId: string; status: string }) => {
        try {
          await linearApi.updateIssueState(issueId, status)
          return { content: [{ type: "text", text: `Issue updated to "${status}"` }], details: {} }
        } catch (err) {
          return { content: [{ type: "text", text: `Failed: ${err}` }], details: { status: "failed" } }
        }
      },
    },
    {
      name: "linear_get_issue",
      label: "Linear Get Issue",
      description: "Get full details of a Linear issue.",
      parameters: {
        type: "object" as const,
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
        },
        required: ["issueId"],
      },
      execute: async (_tc: string, { issueId }: { issueId: string }) => {
        try {
          const issue = await linearApi.getIssueDetails(issueId)
          return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }], details: {} }
        } catch (err) {
          return { content: [{ type: "text", text: `Failed: ${err}` }], details: { status: "failed" } }
        }
      },
    },
    {
      name: "linear_search_issues",
      label: "Linear Search Issues",
      description: "Search for issues in Linear.",
      parameters: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      execute: async (_tc: string, { query, limit = 10 }: { query: string; limit?: number }) => {
        try {
          const data = await linearApi.gql<{
            issueSearch: {
              nodes: Array<{ id: string; identifier: string; title: string; state: { name: string }; url: string }>
            }
          }>(
            `query SearchIssues($query: String!, $limit: Int) {
              issueSearch(query: $query, first: $limit) {
                nodes { id identifier title state { name } url }
              }
            }`,
            { query, limit },
          )
          const results = data.issueSearch.nodes.map((i) => `[${i.identifier}] ${i.title} (${i.state.name}) ${i.url}`)
          return {
            content: [{ type: "text", text: results.length ? results.join("\n") : "No issues found" }],
            details: {},
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Failed: ${err}` }], details: { status: "failed" } }
        }
      },
    },
  ]
}
