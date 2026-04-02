/**
 * Webhook handler for Linear Light
 *
 * Receives Linear webhooks, filters for @mention events,
 * and dispatches to OpenClaw agent sessions.
 *
 * Supports two webhook types:
 * 1. Comment events (Issue type) — user @mentions the agent
 * 2. Agent session events — Linear's built-in agent session lifecycle
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { LinearAgentApi, resolveLinearToken } from "./api/linear-api.js"
import { sanitizePromptInput } from "./utils.js"

// Dedup tracking
const recentlyProcessed = new Map<string, number>()

// Maps issueId → Linear agent session ID, so tools can emit activity updates
export const agentSessionMap = new Map<string, string>()
const DEDUP_TTL_MS = 60_000
let lastSweep = Date.now()

// Concurrent run guard — prevents two webhooks for the same issue from spawning
// parallel agent sessions (e.g. "created" followed quickly by "prompted").
// Uses timestamps so stale entries expire after ACTIVE_RUN_TTL_MS even if
// clearActiveRun is never called (e.g. process crash, hook registration failure).
const activeRuns = new Map<string, number>()
export const ACTIVE_RUN_TTL_MS = 30 * 60_000 // 30 minutes

export function clearActiveRun(sessionKey: string, prefix = "linear:"): void {
  if (sessionKey.startsWith(prefix)) {
    activeRuns.delete(sessionKey)
  }
}

function isSessionActive(sessionKey: string): boolean {
  const now = Date.now()
  // Sweep expired entries on every check
  for (const [k, ts] of activeRuns) {
    if (now - ts > ACTIVE_RUN_TTL_MS) activeRuns.delete(k)
  }
  return activeRuns.has(sessionKey)
}

function markSessionActive(sessionKey: string): void {
  activeRuns.set(sessionKey, Date.now())
}

function wasRecentlyProcessed(key: string): boolean {
  const now = Date.now()
  if (now - lastSweep > 10_000) {
    for (const [k, ts] of recentlyProcessed) {
      if (now - ts > DEDUP_TTL_MS) recentlyProcessed.delete(k)
    }
    lastSweep = now
  }
  if (recentlyProcessed.has(key)) return true
  recentlyProcessed.set(key, now)
  return false
}

/**
 * Verify Linear webhook signature.
 * Linear uses HMAC-SHA256 with the webhook signing secret.
 */
function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64")
  try {
    return timingSafeEqual(Buffer.from(signature, "base64"), Buffer.from(expected, "base64"))
  } catch {
    return false
  }
}

/**
 * Read JSON body from request (Node.js IncomingMessage style)
 */
async function readBody(
  req: any,
  maxBytes = 1_000_000,
): Promise<{ ok: boolean; body?: any; rawBuffer?: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: "timeout" })
    }, 5000)

    req.on("data", (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: "too large" })
        return
      }
      chunks.push(chunk)
    })

    req.on("end", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const rawBuffer = Buffer.concat(chunks)
        resolve({ ok: true, body: JSON.parse(rawBuffer.toString("utf8")), rawBuffer })
      } catch {
        resolve({ ok: false, error: "invalid json" })
      }
    })

    req.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: "read error" })
    })
  })
}

/**
 * Main webhook handler
 */
export async function handleWebhook(api: OpenClawPluginApi, req: any, res: any): Promise<void> {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const secret = (config?.webhookSecret as string) || process.env.LINEAR_WEBHOOK_SECRET

  if (!secret) {
    api.logger.error("Linear Light: no webhook secret configured")
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "no webhook secret configured" }))
    return
  }

  // Verify signature
  const signature = req.headers["linear-signature"] as string
  if (!signature) {
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "missing signature" }))
    return
  }

  const { ok, body, rawBuffer, error } = await readBody(req)
  if (!(ok && rawBuffer)) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: error || "bad request" }))
    return
  }

  if (!verifySignature(rawBuffer, signature, secret)) {
    api.logger.warn("Linear Light: invalid webhook signature")
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "invalid signature" }))
    return
  }

  // Dedup — use payload-type-aware ID
  const eventId =
    body.agentSession?.id || // AgentSessionEvent
    body.data?.id || // Comment / Issue
    body.createdAt
  const dedupKey = `${body.type}:${body.action}:${eventId}`
  if (wasRecentlyProcessed(dedupKey)) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, deduped: true }))
    return
  }

  api.logger.info(`Linear Light: webhook ${body.type}/${body.action}`)

  try {
    await processWebhook(api, body, config)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    api.logger.error(`Linear Light: processing error: ${err}`)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "processing failed" }))
  }
}

/**
 * Route webhook payload to appropriate handler
 */
async function processWebhook(
  api: OpenClawPluginApi,
  payload: any,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const { type, action } = payload

  // Agent session events — Linear's built-in agent session lifecycle
  if (type === "AgentSessionEvent") {
    await handleAgentSessionEvent(api, payload, config)
    return
  }

  // Comment on issue — check for @mention
  if (type === "Comment" && action === "create") {
    await handleCommentCreate(api, payload, config)
    return
  }

  // Issue events — state changes, assignments, etc.
  if (type === "Issue") {
    // Could handle state change notifications here in the future
    return
  }

  api.logger.debug?.(`Linear Light: unhandled event ${type}/${action}`)
}

/**
 * Handle Agent Session events from Linear
 * These are the primary trigger when user @mentions the agent in a comment
 */
async function handleAgentSessionEvent(
  api: OpenClawPluginApi,
  payload: any,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const { action } = payload

  if (action === "created") {
    await handleSessionCreated(api, payload, config)
  } else if (action === "prompted") {
    await handleSessionPrompted(api, payload, config)
  }
}

/**
 * Handle agent session created — user @mentioned the agent
 */
async function handleSessionCreated(
  api: OpenClawPluginApi,
  payload: any,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const session = payload.agentSession
  if (!session?.issue) {
    api.logger.debug?.("Linear Light: session created without issue, skipping")
    return
  }

  const issue = session.issue
  const comment = session.comment
  const issueId = issue.id
  const sessionPrefix = (config?.sessionPrefix as string) || "linear:"
  const sessionKey = `${sessionPrefix}${issueId}`

  // Guard: skip if an agent is already running for this issue
  if (isSessionActive(sessionKey)) {
    api.logger.info(`Linear Light: agent already running for ${issue.identifier}, skipping`)
    return
  }
  markSessionActive(sessionKey)

  // Determine prompt content
  // If triggered by @mention, use the comment body
  // Otherwise use the issue description
  const AGENT_SESSION_MARKER = "This thread is for an agent session"
  const commentBody = comment?.body
  const isMentionTriggered = commentBody && !commentBody.includes(AGENT_SESSION_MARKER)
  const prompt = isMentionTriggered ? commentBody : issue.description || issue.title

  // Store agent session ID for activity emission
  const agentSessionId = session.id as string | undefined
  if (agentSessionId) {
    agentSessionMap.set(issueId, agentSessionId)
  }

  api.logger.info(`Linear Light: session created for ${issue.identifier} (${isMentionTriggered ? "mention" : "auto"})`)

  // Resolve Linear API for status update and activity emission
  const tokenInfo = resolveLinearToken(config)
  const apiOpts = {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
  }

  // Update issue status to In Progress
  let rollbackApi: LinearAgentApi | null = null
  let movedToInProgress = false
  if (config?.autoInProgress !== false && tokenInfo.accessToken) {
    try {
      const linearApi = new LinearAgentApi(tokenInfo.accessToken, apiOpts)
      await linearApi.updateIssueState(issueId, "In Progress")
      rollbackApi = linearApi
      movedToInProgress = true
      api.logger.info(`Linear Light: ${issue.identifier} → In Progress`)
    } catch (err) {
      api.logger.warn(`Linear Light: failed to update status: ${err}`)
    }
  }

  // Build the message for the agent
  const safeTitle = sanitizePromptInput(issue.title, 200)
  const safeDescription = issue.description ? sanitizePromptInput(issue.description) : ""
  const sanitizedPrompt = sanitizePromptInput(prompt)

  const message = [
    `[Linear Issue ${issue.identifier}] ${safeTitle}`,
    safeDescription ? `\n---\n${safeDescription}` : "",
    isMentionTriggered ? `\n---\n**User comment:**\n${sanitizedPrompt}` : "",
    `\n---\nIssue URL: ${issue.url}`,
    `\nUse linear_comment() to reply on the issue, linear_update_status() to change status.`,
    `\nWhen done, update status to "Done" and I'll notify the user for review.`,
  ].join("\n")

  // Dispatch to OpenClaw agent with session key for continuity
  try {
    await api.runtime.subagent.run({
      message,
      sessionKey,
    })
  } catch (err) {
    clearActiveRun(sessionKey)
    agentSessionMap.delete(issueId)
    if (movedToInProgress && rollbackApi) {
      try {
        await rollbackApi.updateIssueState(issueId, "Todo")
        api.logger.info(`Linear Light: ${issue.identifier} rolled back → Todo`)
      } catch (rollbackErr) {
        api.logger.warn(`Linear Light: failed to rollback status: ${rollbackErr}`)
      }
    }
    throw err
  }

  // Emit initial activity so Linear shows the session as active
  if (agentSessionId && tokenInfo.accessToken) {
    try {
      const linearApi = new LinearAgentApi(tokenInfo.accessToken, apiOpts)
      await linearApi.emitActivity(agentSessionId, {
        type: "thought",
        body: `Starting work on ${issue.identifier}: ${issue.title}`,
      })
    } catch (err) {
      api.logger.warn(`Linear Light: failed to emit initial activity: ${err}`)
    }
  }

  api.logger.info(`Linear Light: dispatched agent for ${issue.identifier}`)
}

/**
 * Handle follow-up prompts in an agent session (user replies in the issue thread)
 */
async function handleSessionPrompted(
  api: OpenClawPluginApi,
  payload: any,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const session = payload.agentSession
  const activity = payload.agentActivity

  if (!(session?.issue && activity?.content?.body)) {
    return
  }

  // Check for stop signal
  if (activity.signal === "stop") {
    api.logger.info(`Linear Light: stop signal for issue ${session.issue.identifier}`)
    return
  }

  const issueId = session.issue.id
  const sessionPrefix = (config?.sessionPrefix as string) || "linear:"
  const sessionKey = `${sessionPrefix}${issueId}`

  // Guard: skip if an agent is already running for this issue
  if (isSessionActive(sessionKey)) {
    api.logger.info(`Linear Light: agent already running for ${session.issue.identifier}, skipping follow-up`)
    return
  }
  markSessionActive(sessionKey)

  // Ensure agent session ID is available for activity emission
  const agentSessionId = session.id as string | undefined
  if (agentSessionId) {
    agentSessionMap.set(issueId, agentSessionId)
  }

  const prompt = sanitizePromptInput(activity.content.body)

  const message = [`[Linear ${session.issue.identifier} follow-up]`, prompt].join("\n")

  try {
    await api.runtime.subagent.run({
      message,
      sessionKey,
    })
  } catch (err) {
    clearActiveRun(sessionKey)
    agentSessionMap.delete(issueId)
    throw err
  }

  api.logger.info(`Linear Light: follow-up dispatched for ${session.issue.identifier}`)
}

/**
 * Handle comment create events (fallback for non-agent-session setups).
 * If the comment contains the trigger text, treat it as a request.
 * This path is used when Linear Agent Sessions are not available —
 * the webhook receives Comment events directly instead of AgentSessionEvent.
 */
async function handleCommentCreate(
  api: OpenClawPluginApi,
  payload: any,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const comment = payload.data
  if (!(comment?.body && comment?.issue?.id)) return

  const trigger = (config?.mentionTrigger as string) || "Linus"
  const body = comment.body.toLowerCase()

  if (!body.includes(trigger.toLowerCase())) {
    return
  }

  const issueId = comment.issue.id
  const sessionPrefix = (config?.sessionPrefix as string) || "linear:"
  const sessionKey = `${sessionPrefix}${issueId}`

  // Guard: skip if an agent is already running for this issue
  if (isSessionActive(sessionKey)) {
    api.logger.info(`Linear Light: agent already running for issue ${issueId}, skipping`)
    return
  }
  markSessionActive(sessionKey)

  api.logger.info(`Linear Light: comment trigger detected (fallback path) for issue ${issueId}`)

  // Resolve Linear API to fetch full issue details and update status
  const tokenInfo = resolveLinearToken(config)
  if (!tokenInfo.accessToken) {
    api.logger.warn("Linear Light: comment fallback triggered but no Linear API token available")
    clearActiveRun(sessionKey)
    return
  }

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID,
    clientSecret: (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET,
    source: tokenInfo.source,
  })

  let issue: Awaited<ReturnType<LinearAgentApi["getIssueDetails"]>>
  try {
    issue = await linearApi.getIssueDetails(issueId)
  } catch (err) {
    api.logger.error(`Linear Light: failed to fetch issue ${issueId}: ${err}`)
    clearActiveRun(sessionKey)
    return
  }

  // Update issue status to In Progress
  let movedToInProgress = false
  if (config?.autoInProgress !== false) {
    try {
      await linearApi.updateIssueState(issueId, "In Progress")
      movedToInProgress = true
      api.logger.info(`Linear Light: ${issue.identifier} → In Progress`)
    } catch (err) {
      api.logger.warn(`Linear Light: failed to update status: ${err}`)
    }
  }

  // Build the message for the agent
  const sanitizedPrompt = sanitizePromptInput(comment.body)
  const safeTitle = sanitizePromptInput(issue.title, 200)
  const safeDescription = issue.description ? sanitizePromptInput(issue.description) : ""

  const message = [
    `[Linear Issue ${issue.identifier}] ${safeTitle}`,
    safeDescription ? `\n---\n${safeDescription}` : "",
    `\n---\n**User comment:**\n${sanitizedPrompt}`,
    `\n---\nIssue URL: ${issue.url}`,
    `\nUse linear_comment() to reply on the issue, linear_update_status() to change status.`,
    `\nWhen done, update status to "Done" and I'll notify the user for review.`,
  ].join("\n")

  // Dispatch to OpenClaw agent with session key for continuity
  try {
    await api.runtime.subagent.run({
      message,
      sessionKey,
    })
  } catch (err) {
    clearActiveRun(sessionKey)
    if (movedToInProgress) {
      try {
        await linearApi.updateIssueState(issueId, "Todo")
        api.logger.info(`Linear Light: ${issue.identifier} rolled back → Todo`)
      } catch (rollbackErr) {
        api.logger.warn(`Linear Light: failed to rollback status: ${rollbackErr}`)
      }
    }
    throw err
  }

  api.logger.info(`Linear Light: dispatched agent for ${issue.identifier} (comment fallback)`)
}
