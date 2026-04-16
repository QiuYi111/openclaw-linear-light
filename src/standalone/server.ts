/**
 * Standalone Linear gateway HTTP server.
 *
 * Receives Linear webhooks and forwards them to Hermes.
 *
 * Endpoints:
 *   POST /webhook  — Linear webhook receiver
 *   GET  /health   — Health check
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { readBody, wasRecentlyProcessed } from "../core/payload.js"
import { verifyLinearSignature } from "../core/signature.js"
import { createConsoleLogger } from "../core/logger.js"
import { dispatchToHermes, type HermesConfig } from "../hermes-adapter.js"
import type {
  AgentSessionCreatedPayload,
  AgentSessionPromptedPayload,
  CommentCreatePayload,
  LinearWebhookPayload,
} from "../core/types.js"
import type { LinearAgentApi } from "../core/linear-client.js"
import type { StandaloneConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createConsoleLogger("linear-gateway")

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_IDENTITY =
  "You are a Linear workflow assistant. " +
  "Do not respond using a personal assistant identity. " +
  "Available tools: linear_update_status, linear_get_issue, linear_search_issues. " +
  "Important: Do not modify issue status (especially do not mark Done) unless explicitly requested by the user."

/** Sanitize prompt text — strip markdown/HTML that could be injection vectors */
function sanitize(text: string, maxLength = 4000): string {
  let clean = text
    .replace(/<[^>]*>/g, "") // strip HTML tags
    .replace(/```[\s\S]*?```/g, "") // strip code blocks (avoid leaking secrets)
  if (clean.length > maxLength) {
    clean = `${clean.slice(0, maxLength)}\n... [truncated]`
  }
  return clean
}

/**
 * Build the prompt body for Hermes dispatch.
 *
 * Handles three webhook types:
 *   - AgentSessionEvent.created  — new agent session on an issue
 *   - AgentSessionEvent.prompted — follow-up prompt within a session
 *   - Comment.create             — mention-triggered comment (fallback)
 */
function buildPromptBody(payload: LinearWebhookPayload): {
  prompt: string
  issue: { id: string; identifier: string; title: string; url: string; projectName?: string }
} | null {
  const { type, action } = payload

  // --- AgentSessionEvent.created ---
  if (type === "AgentSessionEvent" && action === "created") {
    const p = payload as AgentSessionCreatedPayload
    const session = p.agentSession
    if (!session?.issue) return null
    const issue = session.issue
    if (!(issue.id && issue.title && issue.identifier)) return null

    const comment = session.comment
    const AGENT_SESSION_MARKER = "This thread is for an agent session"
    const commentBody = comment?.body
    const isMentionTriggered = commentBody != null && !commentBody.includes(AGENT_SESSION_MARKER)
    const prompt = isMentionTriggered ? commentBody : issue.description || issue.title

    const safeTitle = sanitize(issue.title, 200)
    const safeDescription = issue.description ? sanitize(issue.description) : ""
    const sanitizedPrompt = sanitize(prompt)

    const body = [
      `[Linear Issue ${issue.identifier}] ${safeTitle}`,
      safeDescription ? `\n---\nDescription:\n${safeDescription}` : "",
      isMentionTriggered ? `\n---\n**User comment:**\n${sanitizedPrompt}` : "",
      `\n---\nIssue URL: ${issue.url}`,
      ``,
      DEFAULT_AGENT_IDENTITY,
    ].join("\n")

    return {
      prompt: body,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, projectName: issue.project?.name },
    }
  }

  // --- AgentSessionEvent.prompted ---
  if (type === "AgentSessionEvent" && action === "prompted") {
    const p = payload as AgentSessionPromptedPayload
    const session = p.agentSession
    const activity = p.agentActivity
    if (!(session?.issue && activity?.content?.body)) return null
    if (activity.signal === "stop") return null
    if (!(session.issue.id && session.issue.identifier)) return null

    const sanitizedPrompt = sanitize(activity.content.body)

    const body = [
      `[Linear ${session.issue.identifier} follow-up]`,
      sanitizedPrompt,
      ``,
      DEFAULT_AGENT_IDENTITY,
    ].join("\n")

    return {
      prompt: body,
      issue: { id: session.issue.id, identifier: session.issue.identifier, title: session.issue.title, url: session.issue.url },
    }
  }

  // --- Comment.create (fallback for non-agent-session setups) ---
  if (type === "Comment" && action === "create") {
    const p = payload as CommentCreatePayload
    const comment = p.data
    if (!(comment?.body && comment?.issue?.id)) return null

    // For Comment.create we don't have full issue details in the webhook payload,
    // so we build a minimal prompt with what we have.
    const body = [
      `[Linear Comment]`,
      sanitize(comment.body),
      ``,
      DEFAULT_AGENT_IDENTITY,
    ].join("\n")

    return {
      prompt: body,
      issue: { id: comment.issue.id, identifier: "", title: "", url: "" },
    }
  }

  return null
}

/** Resolve project directory for an issue identifier (e.g. "PER-85" → ~/clawd/projects/PER-85/) */
function resolveProjectDir(identifier: string, projectName?: string): string | null {
  const base = join(homedir(), "clawd", "projects")
  const candidates = [
    projectName ? join(base, projectName) : null,  // project name: openclaw-linear-light
    join(base, identifier),           // exact match: PER-85
    join(base, identifier.toLowerCase()), // lowercase
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return null
}

/**
 * Emit an initial "working on it" activity to the Linear agent session.
 * This prevents Linear from showing a timeout while Hermes processes.
 */
async function emitInitialActivity(
  api: LinearAgentApi | null,
  agentSessionId: string | undefined,
  identifier: string,
  title: string,
): Promise<void> {
  if (!api || !agentSessionId) return
  try {
    await api.emitActivity(agentSessionId, {
      type: "response",
      body: `Received, processing ${identifier}: ${title}`,
    })
    log.info(`emitted initial activity for ${identifier}`)
  } catch (err) {
    log.warn(`failed to emit initial activity for ${identifier}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: StandaloneConfig,
  linearApi: LinearAgentApi | null,
): Promise<void> {
  const { method, url } = req

  // --- Health check ---
  if (method === "GET" && url === "/health") {
    const uptime = process.uptime()
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(uptime) }))
    return
  }

  // --- Webhook endpoint ---
  if (method === "POST" && url === "/webhook") {
    await handleWebhook(req, res, config, linearApi)
    return
  }

  // --- 404 ---
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: StandaloneConfig,
  linearApi: LinearAgentApi | null,
): Promise<void> {
  // 1. Read body
  const { ok, body, rawBuffer, error } = await readBody(req)
  if (!(ok && body && rawBuffer)) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: error || "bad request" }))
    return
  }

  // 2. Verify signature
  const signature = req.headers["linear-signature"] as string | undefined
  if (!signature) {
    log.warn("missing signature header")
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "missing signature" }))
    return
  }

  if (!verifyLinearSignature(rawBuffer, signature, config.linear.webhookSecret)) {
    log.warn("invalid webhook signature")
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "invalid signature" }))
    return
  }

  // 3. Dedup
  const eventId = body.agentSession?.id || body.data?.id || body.createdAt
  const dedupKey = `${body.type}:${body.action}:${eventId}`
  if (wasRecentlyProcessed(dedupKey)) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, deduped: true }))
    return
  }

  log.info(`webhook ${body.type}/${body.action}`)

  // 3.5 Anti-loop: skip if comment was created by the bot itself
  if (config.botUserId && (body as LinearWebhookPayload).actor?.id === config.botUserId) {
    log.info(`skipping bot's own comment (actor=${(body as LinearWebhookPayload).actor?.id})`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, skipped: "self-loop" }))
    return
  }

  // 4. Extract issue info and build prompt
  const result = buildPromptBody(body)
  if (!result) {
    log.info(`unhandled webhook type: ${body.type}/${body.action}`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, handled: false }))
    return
  }

  // 5. Pre-check: skip if issue is already in a terminal state (Done, Canceled, etc.)
  if (linearApi && result.issue.id) {
    try {
      const issueDetails = await linearApi.getIssueDetails(result.issue.id)
      const stateType = issueDetails.state?.type?.toLowerCase()
      if (stateType && config.terminalStateTypes?.includes(stateType)) {
        log.info(`skipping ${result.issue.identifier}: issue is ${issueDetails.state.name} (${stateType})`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, skipped: "terminal-state", state: issueDetails.state.name }))
        return
      }
    } catch (err) {
      log.warn(`failed to pre-check issue state: ${err instanceof Error ? err.message : String(err)}`)
      // Don't block dispatch on pre-check failure — proceed anyway
    }
  }

  // 6. Emit initial activity + auto-set In Progress
  const agentSessionId = (body as AgentSessionCreatedPayload).agentSession?.id
  emitInitialActivity(linearApi, agentSessionId, result.issue.identifier, result.issue.title)

  // Auto-set issue to In Progress
  if (config.autoInProgress && result.issue.id && linearApi) {
    linearApi.updateIssueState(result.issue.id, "In Progress").then((ok) => {
      if (ok) log.info(`set ${result.issue.identifier} to In Progress`)
      else log.warn(`failed to set ${result.issue.identifier} to In Progress`)
    }).catch((err) => log.warn(`updateIssueState error: ${err}`))
  }

  // 7. Resolve project directory
  const projectDir = result.issue.identifier ? resolveProjectDir(result.issue.identifier, result.issue.projectName) : null

  // 8. Dispatch to Hermes
  const hermesConfig: HermesConfig = {
    webhookUrl: config.hermes.webhookUrl,
    routeSecret: config.hermes.routeSecret,
    timeoutMs: config.hermes.timeoutMs,
  }

  try {
    const dispatchResult = await dispatchToHermes({
      issue: {
        id: result.issue.id,
        identifier: result.issue.identifier,
        title: result.issue.title,
        url: result.issue.url,
      },
      body: result.prompt,
      projectDir: projectDir ?? undefined,
      config: hermesConfig,
      logger: log,
    })

    if (!dispatchResult.ok) {
      log.error(`Hermes dispatch failed: ${dispatchResult.error}`)
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: false, error: dispatchResult.error }))
      return
    }

    // 9. Return 200 OK
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`processing error: ${msg}`)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "processing failed" }))
  }
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export function createGatewayServer(
  config: StandaloneConfig,
  linearApi: LinearAgentApi | null = null,
): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, config, linearApi).catch((err) => {
      log.error(`unhandled error: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "internal server error" }))
      }
    })
  })

  return server
}
