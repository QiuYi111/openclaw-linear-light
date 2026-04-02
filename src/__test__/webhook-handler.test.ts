import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeAgentSessionCreated, makeAgentSessionPrompted, signPayload } from "./fixtures"

// Cache the real Date.now so we can restore after fake timer tests
const realDateNow = Date.now

// ---------------------------------------------------------------------------
// Webhook handler unit tests
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const mockSubagentRun = vi.fn().mockResolvedValue(undefined)

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("no file")
  }),
  writeFileSync: vi.fn(),
}))

vi.mock("openclaw/plugin-sdk", () => ({}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("handleWebhook", () => {
  const SECRET = "wh-secret-test-123"

  // Module-level state (recentlyProcessed, activeRuns) persists across tests
  // because the module is cached after the first dynamic import.
  // We use unique IDs to avoid collisions.
  let uid = 1

  function makeApi(config: Record<string, unknown> = {}) {
    return {
      pluginConfig: {
        enabled: true,
        webhookSecret: SECRET,
        mentionTrigger: "Linus",
        autoInProgress: true,
        notifyOnComplete: true,
        notificationChannel: "telegram",
        notificationTarget: "12345",
        sessionPrefix: "linear:",
        ...config,
      },
      logger: mockLogger,
      runtime: {
        subagent: { run: mockSubagentRun },
      },
    } as any
  }

  function makeSignedReq(payload: Record<string, unknown>, secret: string) {
    const body = JSON.stringify(payload)
    const sig = signPayload(body, secret)
    const chunks: Buffer[] = [Buffer.from(body)]

    const req = {
      headers: { "linear-signature": sig },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === "data") {
          for (const chunk of chunks) cb(chunk)
        }
        if (event === "end") {
          cb()
        }
      }),
    }

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    }

    return { req, res }
  }

  /** Unique "created" payload — avoids dedup and activeRuns collisions */
  function uniqueCreated(overrides?: Record<string, unknown>) {
    const n = uid++
    return makeAgentSessionCreated({
      createdAt: `2026-04-01T12:00:${String(n).padStart(2, "0")}.000Z`,
      agentSession: {
        id: `sess-uid-${n}`,
        issue: {
          id: `issue-uid-${n}`,
          identifier: `ENG-${n + 100}`,
          title: `Unique issue ${n}`,
          description: `Description for issue ${n}`,
          url: `https://linear.app/eng/issue/ENG-${n + 100}`,
          team: { id: "team-001", key: "ENG", name: "Engineering" },
        },
      },
      ...overrides,
    })
  }

  /** Unique "prompted" payload */
  function uniquePrompted(overrides?: Record<string, unknown>) {
    const n = uid++
    return makeAgentSessionPrompted({
      createdAt: `2026-04-01T12:01:${String(n).padStart(2, "0")}.000Z`,
      agentSession: {
        id: `sess-uid-${n}`,
        issue: {
          id: `issue-uid-${n}`,
          identifier: `ENG-${n + 100}`,
          url: `https://linear.app/eng/issue/ENG-${n + 100}`,
        },
      },
      agentActivity: {
        content: { body: `Follow-up question ${n}` },
        signal: null,
      },
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSubagentRun.mockResolvedValue(undefined)
    mockFetch.mockReset()
  })

  afterEach(() => {
    delete process.env.LINEAR_ACCESS_TOKEN
    delete process.env.LINEAR_API_KEY
  })

  // -----------------------------------------------------------------------
  describe("signature verification", () => {
    // -----------------------------------------------------------------------

    it("rejects requests without signature header", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const body = JSON.stringify(payload)
      const chunks: Buffer[] = [Buffer.from(body)]

      const req = {
        headers: {},
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === "data") for (const chunk of chunks) cb(chunk)
          if (event === "end") cb()
        }),
      }

      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      await handleWebhook(api, req, res)
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object))
    })

    it("rejects requests with invalid signature", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const body = JSON.stringify(payload)
      const chunks: Buffer[] = [Buffer.from(body)]

      const req = {
        headers: { "linear-signature": "invalid-signature" },
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === "data") for (const chunk of chunks) cb(chunk)
          if (event === "end") cb()
        }),
      }

      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      await handleWebhook(api, req, res)
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object))
    })

    it("accepts requests with valid signature", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)
      expect(res.writeHead).not.toHaveBeenCalledWith(401, expect.any(Object))
    })
  })

  // -----------------------------------------------------------------------
  describe("deduplication", () => {
    // -----------------------------------------------------------------------

    it("deduplicates identical webhook payloads", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()

      const { req: req1, res: res1 } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req1, res1)

      const { req: req2, res: res2 } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req2, res2)

      const res2Body = res2.end.mock.calls[0]?.[0]
      expect(res2Body).toContain("deduped")
    })

    it("uses agentSession.id for AgentSessionEvent dedup key", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      // Two payloads with same agentSession.id but different timestamps
      const payload1 = uniqueCreated()
      const payload2 = { ...payload1, createdAt: "2099-01-01T00:00:00.000Z" }

      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)

      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      const res2Body = res2.end.mock.calls[0]?.[0]
      expect(res2Body).toContain("deduped")
    })
  })

  // -----------------------------------------------------------------------
  describe("AgentSessionEvent created", () => {
    // -----------------------------------------------------------------------

    it("dispatches agent with correct session key", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `linear:issue-uid-${uid - 1}`,
        }),
      )
    })

    it("uses sessionPrefix from config", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ sessionPrefix: "custom:" })
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `custom:issue-uid-${uid - 1}`,
        }),
      )
    })

    it("updates issue to In Progress when autoInProgress and accessToken available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // Mock fetch for updateIssueState flow:
      // 1) getIssueDetails  2) getTeamStates  3) issueUpdate mutation
      // 4) emitActivity (initial thought)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                issue: {
                  id: `issue-uid-${uid}`,
                  identifier: `ENG-${uid + 100}`,
                  team: { id: "team-001", key: "ENG", name: "Engineering" },
                },
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                team: {
                  states: {
                    nodes: [
                      { id: "s-todo", name: "Todo" },
                      { id: "s-ip", name: "In Progress" },
                      { id: "s-done", name: "Done" },
                    ],
                  },
                },
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
        })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      // 3 fetch calls for the status update flow + 1 for emitActivity
      expect(mockFetch).toHaveBeenCalledTimes(4)
      const updateCall = mockFetch.mock.calls[2]
      const body = JSON.parse(updateCall[1].body)
      expect(body.variables.input.stateId).toBe("s-ip")
    })

    it("skips session without issue", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated({
        agentSession: { id: `sess-skip-${uid++}`, issue: null },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("skips when agent already running (activeRuns guard)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      // First dispatch — agent starts
      const payload1 = uniqueCreated()
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)

      // Second dispatch with DIFFERENT agentSession.id (bypasses dedup)
      // but SAME issue (hits activeRuns guard)
      const n = uid++
      const payload2 = makeAgentSessionCreated({
        createdAt: `2099-06-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          ...makeAgentSessionCreated().agentSession,
          id: `sess-alt-${n}`,
          issue: payload1.agentSession.issue, // same issue, different session
        },
      })
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      // First call dispatches, second blocked by activeRuns
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  describe("webhook processing errors", () => {
    // -----------------------------------------------------------------------

    it("returns 500 when agent dispatch fails", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      mockSubagentRun.mockRejectedValue(new Error("agent crashed"))
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object))
    })

    it("handles autoInProgress fetch failure gracefully", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // First call fails (getIssueDetails)
      mockFetch.mockRejectedValueOnce(new Error("fetch failed"))

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Should still succeed (status update is best-effort)
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  describe("activeRuns cleanup on failure (handleSessionCreated)", () => {
    // -----------------------------------------------------------------------

    it("clears activeRuns after subagent.run() throws so a retry is allowed", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      // First dispatch fails
      mockSubagentRun.mockRejectedValueOnce(new Error("agent crashed"))
      const payload = uniqueCreated()
      const { req: req1, res: res1 } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req1, res1)
      expect(res1.writeHead).toHaveBeenCalledWith(500, expect.any(Object))

      // Retry for same issue (different session ID to bypass dedup) — should be allowed
      mockSubagentRun.mockResolvedValueOnce(undefined)
      const n = uid++
      const retryPayload = makeAgentSessionCreated({
        createdAt: `2099-09-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          ...payload.agentSession,
          id: `sess-retry-${n}`,
          issue: payload.agentSession.issue,
        },
      })
      const { req: req2, res: res2 } = makeSignedReq(retryPayload, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(2)
    })

    it("clears agentSessionMap when subagent.run() throws", async () => {
      const { handleWebhook, agentSessionMap } = await import("../webhook-handler.js")
      const api = makeApi()

      mockSubagentRun.mockRejectedValueOnce(new Error("agent crashed"))
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object))
      expect(agentSessionMap.has(payload.agentSession.issue.id)).toBe(false)
    })

    it("rolls back issue state to Todo when subagent.run() throws after In Progress", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockSubagentRun.mockRejectedValueOnce(new Error("agent crashed"))

      const payload = uniqueCreated()
      const issueId = payload.agentSession.issue.id

      const issueResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: { id: issueId, identifier: "ENG-X", team: { id: "team-001", key: "ENG", name: "Eng" } },
            },
          }),
      }
      const statesResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "s-todo", name: "Todo" },
                    { id: "s-ip", name: "In Progress" },
                  ],
                },
              },
            },
          }),
      }
      const updateResponse = {
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      }

      mockFetch
        .mockResolvedValueOnce(issueResponse) // getIssueDetails → In Progress
        .mockResolvedValueOnce(statesResponse) // getTeamStates
        .mockResolvedValueOnce(updateResponse) // issueUpdate → In Progress
        .mockResolvedValueOnce(issueResponse) // getIssueDetails → Todo rollback
        .mockResolvedValueOnce(statesResponse) // getTeamStates
        .mockResolvedValueOnce(updateResponse) // issueUpdate → Todo

      const { req, res } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object))
      expect(mockFetch).toHaveBeenCalledTimes(6)
      // Rollback call (6th fetch) should target "Todo" state
      const rollbackBody = JSON.parse(mockFetch.mock.calls[5][1].body)
      expect(rollbackBody.variables.input.stateId).toBe("s-todo")
    })
  })

  // -----------------------------------------------------------------------
  describe("AgentSessionEvent prompted", () => {
    // -----------------------------------------------------------------------

    it("dispatches follow-up for prompted events", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniquePrompted()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalled()
    })

    it("skips prompted events with stop signal", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniquePrompted({
        agentActivity: { signal: "stop", content: { body: "stop" } },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("skips follow-up when agent already running for same issue (activeRuns guard)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      const n = uid++
      const issueId = `issue-uid-${n}`

      // Session created for this issue — adds issueId to activeRuns
      const createdPayload = makeAgentSessionCreated({
        createdAt: `2099-10-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-uid-${n}`,
          issue: {
            id: issueId,
            identifier: `ENG-${n + 100}`,
            title: `Issue ${n}`,
            description: `Desc ${n}`,
            url: `https://linear.app/eng/issue/ENG-${n + 100}`,
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
        },
      })
      const { req: req1, res: res1 } = makeSignedReq(createdPayload, SECRET)
      await handleWebhook(api, req1, res1)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Prompted event for the same issue — should be blocked
      const n2 = uid++
      const promptedPayload = makeAgentSessionPrompted({
        createdAt: `2099-10-01T00:01:${String(n2).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-uid-${n2}`,
          issue: { id: issueId, identifier: `ENG-${n + 100}`, url: `https://linear.app/eng/issue/ENG-${n + 100}` },
        },
        agentActivity: { content: { body: "Follow-up" }, signal: null },
      })
      const { req: req2, res: res2 } = makeSignedReq(promptedPayload, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1) // second was blocked
    })

    it("clears activeRuns after subagent.run() throws in handleSessionPrompted", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      // First prompted fails
      mockSubagentRun.mockRejectedValueOnce(new Error("agent crashed"))
      const payload1 = uniquePrompted()
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)
      expect(res1.writeHead).toHaveBeenCalledWith(500, expect.any(Object))

      // Retry for same issue (different session) — should be allowed
      mockSubagentRun.mockResolvedValueOnce(undefined)
      const n = uid++
      const payload2 = makeAgentSessionPrompted({
        createdAt: `2099-11-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-retry-${n}`,
          issue: payload1.agentSession.issue,
        },
        agentActivity: { content: { body: "Retry prompt" }, signal: null },
      })
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(2)
    })

    it("skips prompted events without content body", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniquePrompted({
        agentActivity: { content: { body: null }, signal: null },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("handleSessionPrompted blocks when agent already running from created event", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()

      // First: created event dispatches agent
      const created = uniqueCreated()
      const { req, res } = makeSignedReq(created, SECRET)
      await handleWebhook(api, req, res)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Second: prompted for SAME issue (different session ID to bypass dedup)
      const prompted = uniquePrompted({
        agentSession: { id: "sess-prompt", issue: created.agentSession.issue },
        agentActivity: { content: { body: "follow up" }, signal: null },
      })
      const { req: r2, res: res2 } = makeSignedReq(prompted, SECRET)
      await handleWebhook(api, r2, res2)

      // activeRuns guard prevents second dispatch
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  describe("Comment create event", () => {
    // -----------------------------------------------------------------------

    it("handles Comment type webhooks (fallback path) — dispatches agent when token available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // Mock fetch for: getIssueDetails (for handleCommentCreate)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: `issue-comment-${uid}`,
                identifier: "ENG-99",
                title: "Comment Issue",
                description: "From comment",
                url: "https://linear.app/eng/issue/ENG-99",
                state: { name: "Todo", type: "unstarted" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                team: { id: "team-001", key: "ENG", name: "Engineering" },
                comments: { nodes: [] },
                project: null,
              },
            },
          }),
      })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-uid-${uid}`,
          body: "@Linus can you check this?",
          issue: { id: `issue-comment-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      // Comment fallback path should dispatch agent
      expect(mockSubagentRun).toHaveBeenCalled()
    })

    it("comment fallback skips when no token available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      // No accessToken configured
      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-notoken-${uid}`,
          body: "@Linus help please",
          issue: { id: `issue-notoken-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("comment fallback handles getIssueDetails failure gracefully", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockFetch.mockRejectedValueOnce(new Error("fetch failed"))

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-fetch-fail-${uid}`,
          body: "@Linus help",
          issue: { id: `issue-fetch-fail-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("comment fallback updates status to In Progress", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const commentIssueId = `issue-cf-status-${uid}`
      // handleCommentCreate calls getIssueDetails, then updateIssueState calls:
      //   getIssueDetails again + getTeamStates + issueUpdate
      mockFetch
        // 1) getIssueDetails (handleCommentCreate)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                issue: {
                  id: commentIssueId,
                  identifier: "ENG-88",
                  title: "Comment Status",
                  description: "Test",
                  url: "https://linear.app/eng/issue/ENG-88",
                  state: { name: "Todo", type: "unstarted" },
                  creator: null,
                  assignee: null,
                  labels: { nodes: [] },
                  team: { id: "team-001", key: "ENG", name: "Engineering" },
                  comments: { nodes: [] },
                  project: null,
                },
              },
            }),
        })
        // 2) getIssueDetails (updateIssueState internal)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                issue: {
                  id: commentIssueId,
                  team: { id: "team-001", key: "ENG", name: "Engineering" },
                },
              },
            }),
        })
        // 3) getTeamStates
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                team: {
                  states: {
                    nodes: [
                      { id: "s-todo", name: "Todo" },
                      { id: "s-ip", name: "In Progress" },
                    ],
                  },
                },
              },
            }),
        })
        // 4) issueUpdate
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
        })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-cf-status-${uid}`,
          body: "@Linus update status",
          issue: { id: commentIssueId },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalled()
      // 4 fetch calls: getIssueDetails (handleCommentCreate) + getIssueDetails + getTeamStates + issueUpdate (updateIssueState)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("skips second comment when agent already running for same issue (activeRuns guard)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const commentIssueId = `issue-ar-comment-${uid}`

      // First comment — agent dispatches and stays in activeRuns
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: commentIssueId,
                identifier: "ENG-77",
                title: "AR Comment Test",
                description: "Test",
                url: "https://linear.app/eng/issue/ENG-77",
                state: { name: "Todo", type: "unstarted" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                team: { id: "team-001", key: "ENG", name: "Engineering" },
                comments: { nodes: [] },
                project: null,
              },
            },
          }),
      })

      const payload1 = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:10:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-ar-1-${uid}`, body: "@Linus first", issue: { id: commentIssueId } },
      }
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Second comment for same issue — blocked by activeRuns
      const payload2 = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T13:11:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-ar-2-${uid}`, body: "@Linus second", issue: { id: commentIssueId } },
      }
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1) // blocked
    })

    it("clears activeRuns after subagent.run() throws in handleCommentCreate", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const commentIssueId = `issue-comment-fail-${uid}`
      const issueData = {
        id: commentIssueId,
        identifier: "ENG-76",
        title: "Comment Failure Test",
        description: "Test",
        url: "https://linear.app/eng/issue/ENG-76",
        state: { name: "Todo", type: "unstarted" },
        creator: null,
        assignee: null,
        labels: { nodes: [] },
        team: { id: "team-001", key: "ENG", name: "Engineering" },
        comments: { nodes: [] },
        project: null,
      }

      // First: getIssueDetails succeeds but run() throws
      mockSubagentRun.mockRejectedValueOnce(new Error("agent crashed"))
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issue: issueData } }),
      })

      const payload1 = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T14:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-fail-1-${uid}`, body: "@Linus first failing", issue: { id: commentIssueId } },
      }
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)
      expect(res1.writeHead).toHaveBeenCalledWith(500, expect.any(Object))

      // Second: should be allowed now that activeRuns is cleared
      mockSubagentRun.mockResolvedValueOnce(undefined)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issue: issueData } }),
      })

      const payload2 = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T14:01:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-fail-2-${uid}`, body: "@Linus second", issue: { id: commentIssueId } },
      }
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(2)
    })

    it("skips Comment without mention trigger", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T14:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-uid-${uid}`,
          body: "Just a normal comment without trigger",
          issue: { id: `issue-comment-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("skips comments authored by the bot (self-trigger prevention)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const botUserId = "bot-user-uuid-001"
      const api = makeApi({ accessToken: "lin_test_token", botUserId })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T16:00:${String(uid++).padStart(2, "0")}.000Z`,
        actor: { id: botUserId, name: "Linus Bot" },
        data: {
          id: `comment-bot-${uid}`,
          body: "@Linus I've completed the fix as requested",
          issue: { id: `issue-bot-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })

    it("processes comments from non-bot users even when botUserId is configured", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token", botUserId: "bot-user-uuid-001" })

      const commentIssueId = `issue-nonbot-${uid}`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: commentIssueId,
                identifier: "ENG-66",
                title: "Non-Bot Comment",
                description: "Test",
                url: "https://linear.app/eng/issue/ENG-66",
                state: { name: "Todo", type: "unstarted" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                team: { id: "team-001", key: "ENG", name: "Engineering" },
                comments: { nodes: [] },
                project: null,
              },
            },
          }),
      })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T16:00:${String(uid++).padStart(2, "0")}.000Z`,
        actor: { id: "human-user-uuid-001", name: "Alice" },
        data: {
          id: `comment-nonbot-${uid}`,
          body: "@Linus can you look at this?",
          issue: { id: commentIssueId },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalled()
    })

    it("processes comments when botUserId is not configured (backward compatible)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })
      // No botUserId in config

      const commentIssueId = `issue-nobbotid-${uid}`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: commentIssueId,
                identifier: "ENG-55",
                title: "No BotUserId",
                description: "Test",
                url: "https://linear.app/eng/issue/ENG-55",
                state: { name: "Todo", type: "unstarted" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                team: { id: "team-001", key: "ENG", name: "Engineering" },
                comments: { nodes: [] },
                project: null,
              },
            },
          }),
      })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T17:00:${String(uid++).padStart(2, "0")}.000Z`,
        actor: { id: "some-user-001", name: "Anyone" },
        data: {
          id: `comment-nobbotid-${uid}`,
          body: "@Linus help me",
          issue: { id: commentIssueId },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalled()
    })

    it("skips bot comments when actor has no id but matches by name (edge case with missing actor.id)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token", botUserId: "bot-user-uuid-001" })

      // Actor without id field — should NOT be filtered (no id to compare)
      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T18:00:${String(uid++).padStart(2, "0")}.000Z`,
        actor: { name: "Linus Bot" },
        data: {
          id: `comment-noactorid-${uid}`,
          body: "@Linus this comment has no actor.id",
          issue: { id: `issue-noactorid-${uid}` },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Without actor.id, the filter can't match — so it passes through
      // but won't dispatch because no token was mocked for fetch
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    })

    it("handleCommentCreate blocks when agent already running from created event (cross-type activeRuns)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // First: created event dispatches agent
      const created = uniqueCreated()
      const { req, res } = makeSignedReq(created, SECRET)
      await handleWebhook(api, req, res)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Second: comment fallback for SAME issue — should be blocked by activeRuns
      const commentPayload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T15:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-cross-type-${uid}`,
          body: "@Linus please help with this",
          issue: { id: created.agentSession.issue.id },
        },
      }
      const { req: r2, res: res2 } = makeSignedReq(commentPayload, SECRET)
      await handleWebhook(api, r2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      // activeRuns guard prevents second dispatch
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  describe("cross-path activeRuns guards", () => {
    // -----------------------------------------------------------------------

    it("handleSessionCreated blocks handleCommentCreate for same issue (cross-path guard)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const crossIssueId = `issue-cross-${uid}`

      // First: AgentSessionEvent created — adds to activeRuns
      const created = makeAgentSessionCreated({
        createdAt: `2099-12-01T00:00:${String(uid++).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-cross-${uid}`,
          issue: {
            id: crossIssueId,
            identifier: `ENG-${uid + 100}`,
            title: `Cross issue ${uid}`,
            description: `Desc ${uid}`,
            url: `https://linear.app/eng/issue/ENG-${uid + 100}`,
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
        },
      })
      const { req: req1, res: res1 } = makeSignedReq(created, SECRET)
      await handleWebhook(api, req1, res1)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Second: Comment create for the same issue — should be blocked by activeRuns
      const commentPayload = {
        type: "Comment",
        action: "create",
        createdAt: `2099-12-01T00:01:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-cross-${uid}`, body: "@Linus follow up", issue: { id: crossIssueId } },
      }
      const { req: req2, res: res2 } = makeSignedReq(commentPayload, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1) // comment was blocked
    })

    it("handleCommentCreate blocks handleSessionPrompted for same issue (cross-path guard)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const crossIssueId = `issue-cross2-${uid}`

      // First: Comment create — adds to activeRuns via comment fallback
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: crossIssueId,
                identifier: `ENG-${uid + 200}`,
                title: "Cross2 Issue",
                description: "Test",
                url: `https://linear.app/eng/issue/ENG-${uid + 200}`,
                state: { name: "Todo", type: "unstarted" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                team: { id: "team-001", key: "ENG", name: "Engineering" },
                comments: { nodes: [] },
                project: null,
              },
            },
          }),
      })

      const commentPayload = {
        type: "Comment",
        action: "create",
        createdAt: `2099-12-02T00:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: { id: `comment-cross2-${uid}`, body: "@Linus start here", issue: { id: crossIssueId } },
      }
      const { req: req1, res: res1 } = makeSignedReq(commentPayload, SECRET)
      await handleWebhook(api, req1, res1)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Second: Prompted event for the same issue — should be blocked by activeRuns
      const n2 = uid++
      const promptedPayload = makeAgentSessionPrompted({
        createdAt: `2099-12-02T00:01:${String(n2).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-cross2-${n2}`,
          issue: {
            id: crossIssueId,
            identifier: `ENG-${n2 + 200}`,
            url: `https://linear.app/eng/issue/ENG-${n2 + 200}`,
          },
        },
        agentActivity: { content: { body: "Follow-up after comment" }, signal: null },
      })
      const { req: req2, res: res2 } = makeSignedReq(promptedPayload, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1) // prompted was blocked
    })
  })

  // -----------------------------------------------------------------------
  describe("unhandled event types", () => {
    // -----------------------------------------------------------------------

    it("returns 200 for unknown event types", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = {
        type: "UnknownType",
        action: "create",
        createdAt: `2026-04-01T15:00:${String(uid++).padStart(2, "0")}.000Z`,
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    })
  })

  // -----------------------------------------------------------------------
  describe("TTL-based activeRuns expiry", () => {
    // -----------------------------------------------------------------------

    afterEach(() => {
      Date.now = realDateNow
    })

    it("expired activeRuns entry allows re-dispatch after TTL", async () => {
      const { handleWebhook, ACTIVE_RUN_TTL_MS } = await import("../webhook-handler.js")
      const api = makeApi()

      // First dispatch — agent starts, session key recorded
      const now = Date.now()
      const payload1 = uniqueCreated()
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)
      expect(res1.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Simulate time passing beyond TTL (crash scenario — clearActiveRun never called)
      const expiredTime = now + ACTIVE_RUN_TTL_MS + 1000
      Date.now = () => expiredTime

      // Second dispatch for same issue (different session ID to bypass dedup)
      // Should succeed because the stale entry was swept
      mockSubagentRun.mockClear()
      const n = uid++
      const payload2 = makeAgentSessionCreated({
        createdAt: `2099-06-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          ...makeAgentSessionCreated().agentSession,
          id: `sess-ttl-${n}`,
          issue: payload1.agentSession.issue,
        },
      })
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)
    })

    it("does NOT re-dispatch before TTL expires", async () => {
      const { handleWebhook, ACTIVE_RUN_TTL_MS } = await import("../webhook-handler.js")
      const api = makeApi()

      const now = Date.now()
      const payload1 = uniqueCreated()
      const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
      await handleWebhook(api, req1, res1)
      expect(mockSubagentRun).toHaveBeenCalledTimes(1)

      // Advance time but stay within TTL
      Date.now = () => now + ACTIVE_RUN_TTL_MS - 1000

      mockSubagentRun.mockClear()
      const n = uid++
      const payload2 = makeAgentSessionCreated({
        createdAt: `2099-07-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          ...makeAgentSessionCreated().agentSession,
          id: `sess-early-${n}`,
          issue: payload1.agentSession.issue,
        },
      })
      const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
      await handleWebhook(api, req2, res2)

      // activeRuns still has the entry — blocked
      expect(res2.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockSubagentRun).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Sanitization tests (imported from utils.ts)
// ---------------------------------------------------------------------------

describe("sanitizePromptInput", () => {
  it("truncates input exceeding maxLength", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    const long = "a".repeat(5000)
    expect(sanitizePromptInput(long, 1000).length).toBe(1000)
  })

  it("escapes double curly braces", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("hello {{world}}")).toBe("hello { {world} }")
  })

  it("returns placeholder for empty input", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("")).toBe("(no content)")
  })

  it("preserves normal text", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("Hello World")).toBe("Hello World")
  })
})
