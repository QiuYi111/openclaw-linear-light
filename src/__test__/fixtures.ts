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

export function makeCommentCreate(overrides?: Record<string, unknown>) {
  return {
    type: "Comment",
    action: "create",
    createdAt: "2026-04-01T12:01:00.000Z",
    data: {
      id: "comment-001",
      body: "@Linus please help",
      issue: { id: "issue-uuid-001" },
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
// Mock OpenClaw Plugin API
// ---------------------------------------------------------------------------

export function makeMockApi(overrides?: Record<string, unknown>) {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  const mockRunAgent = vi.fn().mockResolvedValue(undefined)
  const mockSendNotification = vi.fn().mockResolvedValue(undefined)
  const mockRegisterHttpRoute = vi.fn()
  const mockRegisterTool = vi.fn()
  const mockRegisterHook = vi.fn()

  return {
    pluginConfig: {
      enabled: true,
      webhookSecret: "test-webhook-secret",
      mentionTrigger: "Linus",
      autoInProgress: true,
      notifyOnComplete: true,
      notificationChannel: "telegram",
      notificationTarget: "123456",
      linearClientId: "test-client-id",
      linearClientSecret: "test-client-secret",
    } as Record<string, unknown>,
    logger: mockLogger,
    registerHttpRoute: mockRegisterHttpRoute,
    registerTool: mockRegisterTool,
    registerHook: mockRegisterHook,
    runAgent: mockRunAgent,
    sendNotification: mockSendNotification,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock HTTP req/res for webhook handler tests
// ---------------------------------------------------------------------------

export function makeMockReqRes(body: string, headers: Record<string, string> = {}) {
  const chunks: Buffer[] = [Buffer.from(body)]
  const res = {
    _statusCode: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    writeHead: vi.fn((code: number, headers?: Record<string, string>) => {
      res._statusCode = code
      if (headers) Object.assign(res._headers, headers)
    }),
    end: vi.fn((data?: string) => {
      if (data) res._body = data
    }),
  }

  const req = {
    headers: { "linear-signature": "test-sig", ...headers },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === "data") {
        for (const chunk of chunks) cb(chunk)
      }
      if (event === "end") {
        cb()
      }
    }),
  }

  return { req, res }
}

// ---------------------------------------------------------------------------
// HMAC signature helper
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto"

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
}
