/**
 * Shared test fixtures and mock factories.
 */

// ---------------------------------------------------------------------------
// Webhook payload factories
// ---------------------------------------------------------------------------

export function makeAgentSessionCreated(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    createdAt: "2026-04-01T12:00:00.000Z",
    agentSession: {
      id: "sess-001",
      issue: {
        id: "issue-uuid-001",
        identifier: "ENG-42",
        title: "Fix webhook routing",
        description: "The webhook handler needs fixing.",
        url: "https://linear.app/eng/issue/ENG-42",
        team: { id: "team-001", key: "ENG", name: "Engineering" },
      },
      comment: {
        body: "@Linus please investigate this issue",
      },
    },
    ...overrides,
  }
}

export function makeAgentSessionPrompted(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    createdAt: "2026-04-01T12:05:00.000Z",
    agentSession: {
      id: "sess-001",
      issue: {
        id: "issue-uuid-001",
        identifier: "ENG-42",
        title: "Fix webhook routing",
        url: "https://linear.app/eng/issue/ENG-42",
      },
    },
    agentActivity: {
      content: { body: "Can you also check the error handling?" },
      signal: null,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Linear API response factories
// ---------------------------------------------------------------------------

export function makeIssueDetails(overrides?: Record<string, unknown>) {
  return {
    id: "issue-uuid-001",
    identifier: "ENG-42",
    title: "Fix webhook routing",
    description: "The webhook handler needs fixing.",
    state: { name: "In Progress", type: "started" },
    creator: { name: "Alice", email: "alice@example.com" },
    assignee: { name: "Bob" },
    labels: { nodes: [] },
    team: { id: "team-001", key: "ENG", name: "Engineering" },
    comments: { nodes: [] },
    project: null,
    url: "https://linear.app/eng/issue/ENG-42",
    ...overrides,
  }
}

export function makeTeamStates() {
  return {
    team: {
      states: {
        nodes: [
          { id: "state-todo", name: "Todo" },
          { id: "state-in-progress", name: "In Progress" },
          { id: "state-done", name: "Done" },
          { id: "state-canceled", name: "Canceled" },
        ],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// HMAC signature helper
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto"

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}
