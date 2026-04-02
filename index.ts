/**
 * Linear Light Plugin for OpenClaw
 *
 * Lightweight Linear integration:
 * - Receives webhooks from Linear (comment events, agent session events)
 * - Triggers an agent session per issue when @mentioned
 * - Manages issue status (In Progress → Done)
 * - Sends completion notifications for review
 *
 * Infrastructure borrowed from:
 * - openclaw-linear-plugin (calltelemetry): webhook handling, Linear API, dedup
 * - cyrus linear-event-transport: webhook verification, message translation
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { LinearAgentApi, resolveLinearToken } from "./src/api/linear-api.js"
import { handleOAuthCallback, handleOAuthInit } from "./src/oauth-handler.js"
import { agentSessionMap, clearActiveRun, handleWebhook } from "./src/webhook-handler.js"

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as Record<string, unknown> | undefined

  if (config?.enabled === false) {
    api.logger.info("Linear Light: disabled by config")
    return
  }

  const tokenInfo = resolveLinearToken(config)

  // Always register OAuth routes (needed to obtain the first token)
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

  if (!tokenInfo.accessToken) {
    api.logger.warn("Linear Light: no access token. Visit /linear-light/oauth/init to start OAuth flow.")
    return
  }

  api.logger.info(`Linear Light: token source=${tokenInfo.source}, registering routes...`)

  // Register webhook endpoint
  api.registerHttpRoute({
    path: "/linear-light/webhook",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleWebhook(api, req, res)
    },
  })

  // Register agent tools for Linear interaction
  for (const tool of createLinearTools(api)) {
    api.registerTool(tool)
  }

  // Hook into subagent lifecycle to update Linear status and notify
  api.registerHook("subagent_ended", async (event: any) => {
    await onSubagentEnded(api, event)
  })

  api.logger.info("Linear Light: ready")
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function makeLinearApi(config: Record<string, unknown> | undefined, api: OpenClawPluginApi) {
  const tokenInfo = resolveLinearToken(config)
  if (!tokenInfo.accessToken) return null
  return new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
    logger: api.logger,
  })
}

function createLinearTools(api: OpenClawPluginApi): any[] {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const linearApi = makeLinearApi(config, api)
  if (!linearApi) return []

  return [
    {
      name: "linear_comment",
      label: "Linear Comment",
      description: "Post a comment on a Linear issue. Use this to report progress or results.",
      parameters: {
        type: "object" as const,
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
          body: { type: "string", description: "Comment body (supports Markdown)" },
        },
        required: ["issueId", "body"],
      },
      execute: async (_toolCallId: string, { issueId, body }: { issueId: string; body: string }) => {
        const agentSessionId = agentSessionMap.get(issueId)
        try {
          await linearApi.createComment(issueId, body)

          // Emit response activity so Linear shows progress
          if (agentSessionId) {
            try {
              await linearApi.emitActivity(agentSessionId, { type: "response", body })
            } catch (activityErr) {
              api.logger.warn(`Linear Light: failed to emit activity: ${activityErr}`)
            }
          }

          return { content: [{ type: "text", text: `Comment posted on issue ${issueId}` }], details: {} }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)

          // Emit error activity
          if (agentSessionId) {
            try {
              await linearApi.emitActivity(agentSessionId, { type: "error", body: `Failed to comment: ${msg}` })
            } catch {}
          }

          return {
            content: [{ type: "text", text: `Failed to comment: ${msg}` }],
            details: { status: "failed" },
          }
        }
      },
    },
    {
      name: "linear_update_status",
      label: "Linear Update Status",
      description: "Update a Linear issue's status (e.g. 'In Progress', 'Done', 'Todo').",
      parameters: {
        type: "object" as const,
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
          status: {
            type: "string",
            description: "Target status name (e.g. 'In Progress', 'Done', 'Todo', 'Canceled')",
          },
        },
        required: ["issueId", "status"],
      },
      execute: async (_toolCallId: string, { issueId, status }: { issueId: string; status: string }) => {
        try {
          await linearApi.updateIssueState(issueId, status)
          return { content: [{ type: "text", text: `Issue ${issueId} updated to "${status}"` }], details: {} }
        } catch (err) {
          return {
            content: [
              { type: "text", text: `Failed to update status: ${err instanceof Error ? err.message : String(err)}` },
            ],
            details: { status: "failed" },
          }
        }
      },
    },
    {
      name: "linear_get_issue",
      label: "Linear Get Issue",
      description: "Get full details of a Linear issue including title, description, comments, and state.",
      parameters: {
        type: "object" as const,
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
        },
        required: ["issueId"],
      },
      execute: async (_toolCallId: string, { issueId }: { issueId: string }) => {
        try {
          const issue = await linearApi.getIssueDetails(issueId)
          return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }], details: {} }
        } catch (err) {
          return {
            content: [
              { type: "text", text: `Failed to get issue: ${err instanceof Error ? err.message : String(err)}` },
            ],
            details: { status: "failed" },
          }
        }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Session lifecycle hooks
// ---------------------------------------------------------------------------

async function onSubagentEnded(api: OpenClawPluginApi, event: any): Promise<void> {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const sessionPrefix = (config?.sessionPrefix as string) || "linear:"

  const sessionKey = event?.sessionKey as string | undefined
  if (!sessionKey?.startsWith(sessionPrefix)) return

  const tokenInfo = resolveLinearToken(config)
  if (!tokenInfo.accessToken) return

  // Extract issue ID from session key: "{sessionPrefix}{issueId}"
  const issueId = sessionKey.slice(sessionPrefix.length)
  if (!issueId) return

  // Clear the active run guard
  clearActiveRun(sessionKey, sessionPrefix)

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
    logger: api.logger,
  })

  const success = event?.success !== false

  // Emit error activity if session failed
  if (!success) {
    const agentSessionId = agentSessionMap.get(issueId)
    if (agentSessionId) {
      try {
        await linearApi.emitActivity(agentSessionId, { type: "error", body: "Agent session failed" })
      } catch {}
    }
  }

  try {
    if (success) {
      // Always update status to Done on success (independent of notification preference)
      try {
        await linearApi.updateIssueState(issueId, "Done")
      } catch {
        // Status update is best-effort
      }

      // Send notification only if enabled
      if (config?.notifyOnComplete !== false) {
        try {
          const issue = await linearApi.getIssueDetails(issueId)
          const msg = `✅ Linear issue **[${issue.identifier}] ${issue.title}** completed — please review.\n${issue.url}`

          const target = config?.notificationTarget as string | undefined
          if (target && api.runtime?.channel) {
            const channel = api.runtime.channel as any
            if (typeof channel.sendMessageTelegram === "function") {
              await channel.sendMessageTelegram(target, msg, { silent: true })
            }
          }
        } catch (err) {
          api.logger.warn(`Linear Light: notification failed: ${err}`)
        }
      }
    }
  } catch (err) {
    api.logger.error(`Linear Light: onSubagentEnded failed for ${issueId}: ${err}`)
  } finally {
    agentSessionMap.delete(issueId)
  }
}
