/**
 * Real-time activity streaming for Linear Agent Sessions
 *
 * Hooks into OpenClaw's plugin lifecycle to stream agent thoughts,
 * actions, and responses as Linear AgentActivities.
 *
 * Activity types:
 * - thought: Agent's reasoning/planning (permanent)
 * - action: Tool calls (ephemeral - auto-collapse)
 * - response: Final reply to user (permanent)
 * - error: Errors during execution (permanent)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookContext = any

import { agentSessionMap } from "../index.js"
import { getLinearApi } from "./runtime.js"

// ---------------------------------------------------------------------------
// Debounce state per session
// ---------------------------------------------------------------------------

interface StreamState {
  lastEmitTime: number
  buffer: string
  thoughtCount: number
  isToolCallActive: boolean
  currentToolName: string
  responseEmitted: boolean
}

const sessionStreams = new Map<string, StreamState>()
const DEBOUNCE_MS = 2000
const THOUGHT_MAX_LENGTH = 500

function getStreamState(sessionKey: string): StreamState {
  let state = sessionStreams.get(sessionKey)
  if (!state) {
    state = {
      lastEmitTime: 0,
      buffer: "",
      thoughtCount: 0,
      isToolCallActive: false,
      currentToolName: "",
      responseEmitted: false,
    }
    sessionStreams.set(sessionKey, state)
  }
  return state
}

function cleanupStreamState(sessionKey: string) {
  sessionStreams.delete(sessionKey)
}

// ---------------------------------------------------------------------------
// Activity emission helpers
// ---------------------------------------------------------------------------

async function emitThought(agentSessionId: string, body: string): Promise<void> {
  const api = getLinearApi()
  if (!api) return
  try {
    await api.emitActivity(agentSessionId, {
      type: "thought",
      body: body.slice(0, THOUGHT_MAX_LENGTH),
    })
  } catch (err) {
    // Non-critical — don't block agent
    console.error("[Linear Light] failed to emit thought:", err)
  }
}

async function emitAction(agentSessionId: string, toolName: string, isStart: boolean): Promise<void> {
  const api = getLinearApi()
  if (!api) return
  try {
    await api.emitActivity(agentSessionId, {
      type: "thought", // Linear doesn't have a dedicated "action" type in our schema
      body: isStart ? `🔧 ${toolName}...` : `✅ ${toolName} done`,
    })
  } catch (err) {
    console.error("[Linear Light] failed to emit action:", err)
  }
}

async function emitResponse(agentSessionId: string, body: string): Promise<void> {
  const api = getLinearApi()
  if (!api) return
  try {
    await api.emitActivity(agentSessionId, {
      type: "response",
      body: body.slice(0, 2000),
    })
  } catch (err) {
    console.error("[Linear Light] failed to emit response:", err)
  }
}

// ---------------------------------------------------------------------------
// Session key → agent session ID resolution
// ---------------------------------------------------------------------------

function resolveAgentSessionId(sessionKey: string): string | null {
  // sessionKey format: "linear:<issue-uuid>"
  // agentSessionMap: issueId → linear agent session ID
  if (!sessionKey.startsWith("linear:")) return null
  const issueId = sessionKey.slice("linear:".length)
  return agentSessionMap.get(issueId) ?? null
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

/**
 * Called on every LLM output chunk.
 * Debounces text into "thought" activities.
 */
export async function onLlmOutput(
  event: { assistantTexts: string[]; runId: string; sessionId: string },
  ctx: HookContext,
): Promise<void> {
  const sessionKey = ctx.sessionKey
  if (!sessionKey?.startsWith("linear:")) return

  const agentSessionId = resolveAgentSessionId(sessionKey)
  if (!agentSessionId) return

  const texts = event.assistantTexts
  if (!texts || texts.length === 0) return

  const state = getStreamState(sessionKey)
  const latestText = texts[texts.length - 1] ?? ""

  // Don't emit during tool calls — the action activity handles that
  if (state.isToolCallActive) return

  state.buffer = latestText
  const now = Date.now()

  // Emit thought if enough time has passed and buffer has meaningful content
  if (now - state.lastEmitTime > DEBOUNCE_MS && latestText.length > 20) {
    state.thoughtCount++
    state.lastEmitTime = now
    await emitThought(agentSessionId, latestText)
  }
}

/**
 * Called before a tool is invoked.
 * Emits an "action starting" activity.
 */
export function onBeforeToolCall(event: { toolName: string; input: unknown }, ctx: HookContext): void {
  const sessionKey = ctx.sessionKey
  if (!sessionKey?.startsWith("linear:")) return

  const agentSessionId = resolveAgentSessionId(sessionKey)
  if (!agentSessionId) return

  const state = getStreamState(sessionKey)
  state.isToolCallActive = true
  state.currentToolName = event.toolName

  // Fire and forget
  emitAction(agentSessionId, event.toolName, true).catch(() => {})
}

/**
 * Called after a tool returns.
 * Emits an "action complete" activity.
 */
export function onAfterToolCall(event: { toolName: string; output: unknown }, ctx: HookContext): void {
  const sessionKey = ctx.sessionKey
  if (!sessionKey?.startsWith("linear:")) return

  const agentSessionId = resolveAgentSessionId(sessionKey)
  if (!agentSessionId) return

  const state = getStreamState(sessionKey)
  state.isToolCallActive = false
  state.currentToolName = ""

  // Fire and forget
  emitAction(agentSessionId, event.toolName, false).catch(() => {})
}

/**
 * Called when the agent finishes.
 * Emits a "response" activity with the final text,
 * then cleans up stream state.
 */
export async function onAgentEnd(
  event: { success: boolean; error?: string; messages: unknown[] },
  ctx: HookContext,
): Promise<void> {
  const sessionKey = ctx.sessionKey
  if (!sessionKey?.startsWith("linear:")) return

  const agentSessionId = resolveAgentSessionId(sessionKey)
  if (!agentSessionId) return

  const state = getStreamState(sessionKey)

  if (!event.success && event.error) {
    await emitThought(agentSessionId, `❌ Error: ${event.error}`)
  } else if (state.buffer && !state.responseEmitted) {
    // Emit remaining buffer as response
    state.responseEmitted = true
    await emitResponse(agentSessionId, state.buffer)
  }

  // Cleanup after a delay (in case of follow-up)
  setTimeout(() => cleanupStreamState(sessionKey), 5000)
}
