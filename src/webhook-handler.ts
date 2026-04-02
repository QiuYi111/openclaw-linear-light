/**
 * Webhook handler for Linear Light (Channel Mode)
 *
 * Receives Linear webhooks, dispatches inbound messages to OpenClaw
 * via dispatchInboundReplyWithBase(). Agent replies are delivered back
 * to Linear via the outbound adapter (sendText → createComment).
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import {
  dispatchInboundReplyWithBase,
  type OpenClawConfig,
} from "openclaw/plugin-sdk"
import { LinearAgentApi, resolveLinearToken } from "./api/linear-api.js"
import { sanitizePromptInput } from "./utils.js"
import { getLinearRuntime } from "./runtime.js"
import { agentSessionMap } from "../index.js"

const CHANNEL_ID = "linear" as const

// Dedup tracking
const recentlyProcessed = new Map<string, number>()
const DEDUP_TTL_MS = 60_000
let lastSweep = Date.now()

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

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  try {
    return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))
  } catch {
    return false
  }
}

async function readBody(
  req: any,
  maxBytes = 1_000_000,
): Promise<{ ok: boolean; body?: any; rawBuffer?: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: "timeout" }) } }, 5000)
    req.on("data", (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) { settled = true; clearTimeout(timer); resolve({ ok: false, error: "too large" }); return }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const rawBuffer = Buffer.concat(chunks)
        resolve({ ok: true, body: JSON.parse(rawBuffer.toString("utf8")), rawBuffer })
      } catch { resolve({ ok: false, error: "invalid json" }) }
    })
    req.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: "read error" }) } })
  })
}

export async function handleWebhook(api: OpenClawPluginApi, req: any, res: any): Promise<void> {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const secret = config?.webhookSecret as string | undefined

  if (!secret) {
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "no webhook secret" }))
    return
  }

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

  const eventId = body.agentSession?.id || body.data?.id || body.createdAt
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

async function processWebhook(api: OpenClawPluginApi, payload: any, config: Record<string, unknown> | undefined): Promise<void> {
  const { type, action } = payload

  if (type === "AgentSessionEvent") {
    if (action === "created") await handleSessionCreated(api, payload, config)
    else if (action === "prompted") await handleSessionPrompted(api, payload, config)
    return
  }

  if (type === "Comment" && action === "create") {
    await handleCommentCreate(api, payload, config)
    return
  }
}

// ---------------------------------------------------------------------------
// Agent Session events (primary trigger — user @mentions agent)
// ---------------------------------------------------------------------------

async function handleSessionCreated(api: OpenClawPluginApi, payload: any, config: Record<string, unknown> | undefined): Promise<void> {
  const session = payload.agentSession
  if (!session?.issue) return

  const issue = session.issue
  if (!(issue.id && issue.title && issue.identifier)) return

  const comment = session.comment
  const AGENT_SESSION_MARKER = "This thread is for an agent session"
  const commentBody = comment?.body
  const isMentionTriggered = commentBody && !commentBody.includes(AGENT_SESSION_MARKER)
  const prompt = isMentionTriggered ? commentBody : issue.description || issue.title

  // Store agent session ID for emitActivity
  if (session.id) agentSessionMap.set(issue.id, session.id)

  // Update issue status to In Progress
  const linearApi = makeLinearApi(config, api)
  if (config?.autoInProgress !== false && linearApi) {
    try {
      await linearApi.updateIssueState(issue.id, "In Progress")
      api.logger.info(`Linear Light: ${issue.identifier} → In Progress`)
    } catch (err) {
      api.logger.warn(`Linear Light: failed to update status: ${err}`)
    }
  }

  // Emit initial response activity immediately — Linear times out after ~15s
  if (session.id && linearApi) {
    try {
      await linearApi.emitActivity(session.id, {
        type: "response",
        body: `已收到，正在处理 ${issue.identifier}: ${issue.title}`,
      })
      api.logger.info(`Linear Light: emitted initial activity for ${issue.identifier}`)
    } catch (err) {
      api.logger.warn(`Linear Light: failed to emit initial activity: ${err}`)
    }
  }

  const safeTitle = sanitizePromptInput(issue.title, 200)
  const safeDescription = issue.description ? sanitizePromptInput(issue.description) : ""
  const sanitizedPrompt = sanitizePromptInput(prompt)

  const body = [
    `[Linear Issue ${issue.identifier}] ${safeTitle}`,
    safeDescription ? `\n---\nDescription:\n${safeDescription}` : "",
    isMentionTriggered ? `\n---\n**User comment:**\n${sanitizedPrompt}` : "",
    `\n---\nIssue URL: ${issue.url}`,
    `\n可用工具：linear_update_status（改状态）、linear_get_issue（查详情）、linear_search_issues（搜索）。`,
    `\n【重要】不要主动修改 issue 状态（尤其不要标 Done），除非用户明确要求。`,
  ].join("\n")

  await dispatchToAgent(api, { issue, body, config })
}

async function handleSessionPrompted(api: OpenClawPluginApi, payload: any, config: Record<string, unknown> | undefined): Promise<void> {
  const session = payload.agentSession
  const activity = payload.agentActivity

  if (!(session?.issue && activity?.content?.body)) return
  if (!(session.issue.id && session.issue.identifier)) return
  if (activity.signal === "stop") return

  if (session.id) agentSessionMap.set(session.issue.id, session.id)

  const prompt = sanitizePromptInput(activity.content.body)
  const body = [`[Linear ${session.issue.identifier} follow-up]`, prompt].join("\n")

  await dispatchToAgent(api, { issue: session.issue, body, config })
}

// ---------------------------------------------------------------------------
// Comment fallback (non-agent-session setups)
// ---------------------------------------------------------------------------

async function handleCommentCreate(api: OpenClawPluginApi, payload: any, config: Record<string, unknown> | undefined): Promise<void> {
  const comment = payload.data
  if (!(comment?.body && comment?.issue?.id)) return

  const trigger = (config?.mentionTrigger as string) || "Linus"
  if (!comment.body.toLowerCase().includes(trigger.toLowerCase())) return

  const botUserId = (config?.botUserId as string) || process.env.LINEAR_BOT_USER_ID
  if (botUserId && payload.actor?.id === botUserId) return

  const issueId = comment.issue.id
  const linearApi = makeLinearApi(config, api)
  if (!linearApi) return

  let issue: Awaited<ReturnType<LinearAgentApi["getIssueDetails"]>>
  try {
    issue = await linearApi.getIssueDetails(issueId)
  } catch (err) {
    api.logger.error(`Linear Light: failed to fetch issue ${issueId}: ${err}`)
    return
  }

  if (config?.autoInProgress !== false) {
    try { await linearApi.updateIssueState(issueId, "In Progress") } catch { /* best-effort */ }
  }

  const sanitizedPrompt = sanitizePromptInput(comment.body)
  const safeTitle = sanitizePromptInput(issue.title, 200)
  const safeDescription = issue.description ? sanitizePromptInput(issue.description) : ""

  const body = [
    `[Linear Issue ${issue.identifier}] ${safeTitle}`,
    safeDescription ? `\n---\nDescription:\n${safeDescription}` : "",
    `\n---\n**User comment:**\n${sanitizedPrompt}`,
    `\n---\nIssue URL: ${issue.url}`,
  ].join("\n")

  await dispatchToAgent(api, { issue, body, config })
}

// ---------------------------------------------------------------------------
// Core: dispatch message to OpenClaw agent via channel injection
// ---------------------------------------------------------------------------

async function dispatchToAgent(
  api: OpenClawPluginApi,
  params: {
    issue: { id: string; identifier: string; title: string; description?: string | null; url?: string }
    body: string
    config: Record<string, unknown> | undefined
  },
): Promise<void> {
  const { issue, body, config } = params
  const core = getLinearRuntime()
  const cfg = config as OpenClawConfig

  // Use issue identifier as peer ID (e.g. "DEV-134")
  const peerId = issue.identifier

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: { kind: "direct", id: peerId },
  })

  const storePath = core.channel.session.resolveStorePath(
    (cfg as any).session?.store,
    { agentId: route.agentId },
  )

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: body,
    CommandBody: body,
    From: `linear:issue:${peerId}`,
    To: `linear:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `Linear ${issue.identifier}`,
    SenderName: "Linear",
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `linear:${peerId}`,
  })

  // No deliver callback needed — outbound adapter handles delivery
  await dispatchInboundReplyWithBase({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    route,
    storePath,
    ctxPayload,
    core: {
      channel: {
        session: {
          recordInboundSession: core.channel.session.recordInboundSession,
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    },
  })

  api.logger.info(`Linear Light: dispatched agent for ${issue.identifier} (channel mode)`)
}

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
