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

import { createHmac, timingSafeEqual } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLinearToken, LinearAgentApi } from "./api/linear-api.js";
import { handleWebhook } from "./webhook-handler.js";

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as Record<string, unknown> | undefined;

  if (!config?.enabled) {
    api.logger.info("Linear Light: disabled by config");
    return;
  }

  // Resolve Linear API token
  const tokenInfo = resolveLinearToken(config);
  if (!tokenInfo.accessToken) {
    api.logger.warn(
      "Linear Light: no access token. Set LINEAR_ACCESS_TOKEN env var or run OAuth flow.",
    );
    return;
  }

  api.logger.info(`Linear Light: token source=${tokenInfo.source}, registering routes...`);

  // Register webhook route
  api.registerHttpRoute({
    path: "/linear-light/webhook",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleWebhook(api, req, res);
    },
  });

  // Register agent tools for Linear interaction
  api.registerTool((ctx) => createLinearTools(api, ctx));

  // Hook into session lifecycle to update Linear status
  api.registerHook("agent_end", async (event) => {
    await onAgentEnd(api, event);
  });

  api.logger.info("Linear Light: ready");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function createLinearTools(api: OpenClawPluginApi, ctx: any) {
  const config = api.pluginConfig as Record<string, unknown> | undefined;
  const tokenInfo = resolveLinearToken(config);
  if (!tokenInfo.accessToken) return [];

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
  });

  return [
    {
      name: "linear_comment",
      description: "Post a comment on a Linear issue. Use this to report progress or results.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
          body: { type: "string", description: "Comment body (supports Markdown)" },
        },
        required: ["issueId", "body"],
      },
      execute: async ({ issueId, body }: { issueId: string; body: string }) => {
        try {
          await linearApi.createComment(issueId, body);
          return `Comment posted on issue ${issueId}`;
        } catch (err) {
          return `Failed to comment: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: "linear_update_status",
      description: "Update a Linear issue's status (e.g. 'In Progress', 'Done', 'Todo').",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
          status: {
            type: "string",
            description: "Target status name (e.g. 'In Progress', 'Done', 'Todo', 'Canceled')",
          },
        },
        required: ["issueId", "status"],
      },
      execute: async ({ issueId, status }: { issueId: string; status: string }) => {
        try {
          await linearApi.updateIssueState(issueId, status);
          return `Issue ${issueId} updated to "${status}"`;
        } catch (err) {
          return `Failed to update status: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: "linear_get_issue",
      description: "Get full details of a Linear issue including title, description, comments, and state.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The Linear issue UUID" },
        },
        required: ["issueId"],
      },
      execute: async ({ issueId }: { issueId: string }) => {
        try {
          const issue = await linearApi.getIssueDetails(issueId);
          return JSON.stringify(issue, null, 2);
        } catch (err) {
          return `Failed to get issue: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Session lifecycle hooks
// ---------------------------------------------------------------------------

async function onAgentEnd(api: OpenClawPluginApi, event: any) {
  const sessionKey = event?.sessionKey as string | undefined;
  if (!sessionKey?.startsWith("linear:")) return;

  const config = api.pluginConfig as Record<string, unknown> | undefined;
  const tokenInfo = resolveLinearToken(config);
  if (!tokenInfo.accessToken) return;

  // Extract issue ID from session key: "linear:{issueId}"
  const issueId = sessionKey.slice("linear:".length);
  if (!issueId) return;

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
  });

  const success = event?.success !== false;

  try {
    if (success && config?.notifyOnComplete !== false) {
      // Update status to Done
      try {
        await linearApi.updateIssueState(issueId, "Done");
      } catch {
        // Status update is best-effort
      }

      // Send notification via OpenClaw
      const channel = (config?.notificationChannel as string) || "telegram";
      const target = config?.notificationTarget as string | undefined;
      const issue = await linearApi.getIssueDetails(issueId);

      const msg = `✅ Linear issue **[${issue.identifier}] ${issue.title}** 已完成，请 review。\n${issue.url}`;

      await api.sendNotification({
        channel,
        target,
        message: msg,
      });
    }
  } catch (err) {
    api.logger.error(`Linear Light: onAgentEnd failed for ${issueId}: ${err}`);
  }
}
