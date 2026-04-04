/**
 * Shared type definitions for the Linear Light plugin.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

// Re-export HTTP types for handler functions
export type { IncomingMessage, ServerResponse }

// ---------------------------------------------------------------------------
// Linear webhook payload types
// ---------------------------------------------------------------------------

export interface LinearWebhookIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  team?: { id: string; key: string; name: string }
}

export interface LinearWebhookAgentSession {
  id: string
  issue: LinearWebhookIssue | null
  comment?: { body?: string | null } | null
}

export interface LinearWebhookAgentActivity {
  content?: { body?: string | null } | null
  signal?: string | null
}

/** Base shape for all Linear webhook payloads. */
export interface LinearWebhookPayload {
  type: string
  action: string
  createdAt: string
  agentSession?: LinearWebhookAgentSession
  agentActivity?: LinearWebhookAgentActivity
  data?: Record<string, unknown>
  actor?: { id?: string; name?: string } | null
}

/** Payload for AgentSessionEvent.created */
export interface AgentSessionCreatedPayload extends LinearWebhookPayload {
  type: "AgentSessionEvent"
  action: "created"
  agentSession: LinearWebhookAgentSession
}

/** Payload for AgentSessionEvent.prompted */
export interface AgentSessionPromptedPayload extends LinearWebhookPayload {
  type: "AgentSessionEvent"
  action: "prompted"
  agentSession: LinearWebhookAgentSession
  agentActivity: LinearWebhookAgentActivity
}

/** Payload for Comment.create */
export interface CommentCreatePayload extends LinearWebhookPayload {
  type: "Comment"
  action: "create"
  data: { id: string; body: string; issue: { id: string } }
}
