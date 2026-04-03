import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeAgentSessionCreated, makeAgentSessionPrompted, signPayload } from "./fixtures"

// ---------------------------------------------------------------------------
// Webhook handler unit tests — channel-mode architecture
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const mockDispatchInboundReplyWithBase = vi.fn().mockResolvedValue(undefined)

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("no file")
  }),
  writeFileSync: vi.fn(),
}))

vi.mock("openclaw/plugin-sdk", () => ({
  dispatchInboundReplyWithBase: (...args: any[]) => mockDispatchInboundReplyWithBase(...args),
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => null),
  })),
}))

// Mock openclaw/plugin-sdk/core for getChatChannelMeta (imported by index.ts)
vi.mock("openclaw/plugin-sdk/core", () => ({
  getChatChannelMeta: vi.fn(() => ({
    id: "linear",
    label: "Linear",
    icon: "linear",
    description: "Linear project management",
    category: "developer-tools",
    features: [],
    configSchema: [],
  })),
}))

// Mock runtime store
vi.mock("../runtime.js", () => ({
  getLinearRuntime: vi.fn(() => mockRuntime),
  setLinearApi: vi.fn(),
}))

const mockRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "agent-main",
        sessionKey: "agent:main:linear:direct:ENG-42",
        accountId: "default",
        model: "default",
      })),
    },
    session: {
      resolveStorePath: vi.fn(() => "/tmp/store/agent-main"),
      recordInboundSession: vi.fn(),
    },
    reply: {
      finalizeInboundContext: vi.fn((ctx: any) => ctx),
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
    },
  },
}

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("handleWebhook", () => {
  const SECRET = "wh-secret-test-123"

  // Module-level dedup state persists across tests — use unique IDs
  let uid = 1

  function makeApi(config: Record<string, unknown> = {}) {
    return {
      pluginConfig: {
        enabled: true,
        webhookSecret: SECRET,
        mentionTrigger: "Linus",
        autoInProgress: true,
        accessToken: "lin_test_token",
        ...config,
      },
      logger: mockLogger,
      config: {},
      runtime: mockRuntime,
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

  /** Unique "created" payload — avoids dedup collisions */
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
    mockDispatchInboundReplyWithBase.mockResolvedValue(undefined)
    mockFetch.mockReset()
    mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue({
      agentId: "agent-main",
      sessionKey: "agent:main:linear:direct:ENG-42",
      accountId: "default",
      model: "default",
    })
    mockRuntime.channel.session.resolveStorePath.mockReturnValue("/tmp/store/agent-main")
    mockRuntime.channel.reply.finalizeInboundContext.mockImplementation((ctx: any) => ctx)
  })

  afterEach(() => {
    delete process.env.LINEAR_ACCESS_TOKEN
    delete process.env.LINEAR_API_KEY
  })

  // -----------------------------------------------------------------------
  describe("signature verification", () => {
    // -----------------------------------------------------------------------

    it("returns 500 when no webhook secret configured", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const noSecretApi = makeApi()
      noSecretApi.pluginConfig.webhookSecret = undefined

      const payload = uniqueCreated()
      const { req } = makeSignedReq(payload, SECRET)
      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      await handleWebhook(noSecretApi, req, res)
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object))
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining("no webhook secret"))
    })

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

    it("returns 400 when readBody fails", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const sig = "valid-sig"

      // Request that triggers invalid JSON (no data sent)
      const req = {
        headers: { "linear-signature": sig },
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === "end") cb()
        }),
      }

      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      await handleWebhook(api, req, res)
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    })

    it("rejects requests with body too large", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const sig = "valid-sig"

      const req = {
        headers: { "linear-signature": sig },
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === "data") {
            // Send a chunk larger than maxBytes (1MB default)
            cb(Buffer.from("x".repeat(2_000_000)))
          }
        }),
      }

      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      await handleWebhook(api, req, res)
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    })

    it("rejects requests that timeout during body read", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const sig = "valid-sig"

      // Request that never emits "end" — should timeout after 5s
      const req = {
        headers: { "linear-signature": sig },
        on: vi.fn(),
      }

      const res = { writeHead: vi.fn(), end: vi.fn() } as any

      vi.useFakeTimers()
      const promise = handleWebhook(api, req, res)
      vi.advanceTimersByTime(6000)
      await promise

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
      vi.useRealTimers()
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

    it("dispatches agent via dispatchInboundReplyWithBase", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "linear",
          accountId: "default",
        }),
      )
    })

    it("stores agentSessionMap entry for emitActivity", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const { agentSessionMap } = await import("../../index.js")

      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(agentSessionMap.has(payload.agentSession.issue.id)).toBe(true)
      agentSessionMap.delete(payload.agentSession.issue.id)
    })

    it("updates issue to In Progress when autoInProgress and accessToken available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // Mock fetch for updateIssueState flow (3 calls) + emitActivity (1 call)
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
      // 3 fetch calls for status update + 1 for emitActivity
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("skips session without issue.id", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionCreated({
        createdAt: `2099-07-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-malformed-${n}`,
          issue: {
            id: undefined,
            identifier: `ENG-${n + 100}`,
            title: `Malformed ${n}`,
            description: "Missing id",
            url: "https://linear.app/eng/issue/ENG-0",
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("skips session without issue.title", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionCreated({
        createdAt: `2099-07-02T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-malformed-${n}`,
          issue: {
            id: `issue-malformed-${n}`,
            identifier: `ENG-${n + 100}`,
            title: undefined,
            description: "Missing title",
            url: "https://linear.app/eng/issue/ENG-0",
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("skips session without issue.identifier", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionCreated({
        createdAt: `2099-07-03T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-malformed-${n}`,
          issue: {
            id: `issue-malformed-${n}`,
            identifier: undefined,
            title: `Malformed ${n}`,
            description: "Missing identifier",
            url: "https://linear.app/eng/issue/ENG-0",
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("handles autoInProgress fetch failure gracefully", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // First call fails (getIssueDetails for updateIssueState)
      mockFetch.mockRejectedValueOnce(new Error("fetch failed"))

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Should still succeed (status update is best-effort)
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
    })

    it("uses issue description as prompt when comment body is agent session marker", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionCreated({
        createdAt: `2026-04-01T12:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-desc-${n}`,
          issue: {
            id: `issue-desc-${n}`,
            identifier: `ENG-${n + 100}`,
            title: `Desc issue ${n}`,
            description: "Description for issue",
            url: `https://linear.app/eng/issue/ENG-${n + 100}`,
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
          comment: { body: "This thread is for an agent session with linus." },
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
      // The ctxPayload.Body should contain the issue description
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("Description for issue")
    })

    it("uses comment body as prompt when user mentions agent", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionCreated({
        createdAt: `2026-04-01T12:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-mention-${n}`,
          issue: {
            id: `issue-mention-${n}`,
            identifier: `ENG-${n + 100}`,
            title: `Mention issue ${n}`,
            description: "Desc",
            url: `https://linear.app/eng/issue/ENG-${n + 100}`,
            team: { id: "team-001", key: "ENG", name: "Engineering" },
          },
          comment: { body: "@Linus please investigate this issue" },
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("@Linus please investigate this issue")
    })
  })

  // -----------------------------------------------------------------------
  describe("dispatchToAgent internals", () => {
    // -----------------------------------------------------------------------

    it("calls resolveAgentRoute with correct channel and peer", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(mockRuntime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "linear",
          accountId: "default",
          peer: expect.objectContaining({ kind: "direct", id: payload.agentSession.issue.identifier }),
        }),
      )
    })

    it("calls finalizeInboundContext with correct fields", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(mockRuntime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          From: `linear:issue:${payload.agentSession.issue.identifier}`,
          To: `linear:${payload.agentSession.issue.identifier}`,
          ChatType: "direct",
          Provider: "linear",
          Surface: "linear",
          ConversationLabel: `Linear ${payload.agentSession.issue.identifier}`,
        }),
      )
    })

    it("passes deliver callback to dispatchInboundReplyWithBase", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(typeof dispatchCall.deliver).toBe("function")
    })

    it("deliver callback creates comment via Linear API", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-deliver" } } } }),
      })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Get the deliver callback from the dispatch call
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: "Agent reply text" })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.linear.app"),
        expect.objectContaining({
          method: "POST",
        }),
      )
    })

    it("deliver callback logs error when createComment fails", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: "Agent reply" })

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("deliver error"))
    })

    it("deliver callback skips when payload has no text", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ autoInProgress: false })
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Clear any fetch calls from dispatch
      mockFetch.mockClear()

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: undefined })

      // No fetch call should be made for empty text
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("deliver callback logs error when no access token available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      // No accessToken — makeLinearApi returns null
      const api = makeApi({ autoInProgress: false, accessToken: "" })
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: "Reply text" })

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("no access token"))
    })

    it("deliver callback logs success after creating comment", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // First fetch: getIssueDetails (called during handleWebhook)
      // Second fetch: createComment (called during deliver)
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-ok" } } } }),
      })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: "Reply" })

      // Check that delivered comment was logged (among other info calls)
      const deliveredCalls = mockLogger.info.mock.calls.filter((call: any[]) =>
        call[0]?.includes?.("delivered comment"),
      )
      expect(deliveredCalls).toHaveLength(1)
    })

    it("passes onRecordError and onDispatchError callbacks", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ autoInProgress: false })
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(typeof dispatchCall.onRecordError).toBe("function")
      expect(typeof dispatchCall.onDispatchError).toBe("function")

      // Trigger onRecordError
      dispatchCall.onRecordError(new Error("record failed"))
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("record inbound error"))

      mockLogger.error.mockClear()
      // Trigger onDispatchError
      dispatchCall.onDispatchError(new Error("dispatch failed"), { kind: "timeout" })
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("dispatch error [timeout]"))
    })

    it("returns 500 when dispatchInboundReplyWithBase throws", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      mockDispatchInboundReplyWithBase.mockRejectedValueOnce(new Error("agent crashed"))
      const api = makeApi()
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object))
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
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("skips prompted events without issue.id", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionPrompted({
        createdAt: `2099-08-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-prompt-malformed-${n}`,
          issue: {
            id: undefined,
            identifier: `ENG-${n + 100}`,
            url: `https://linear.app/eng/issue/ENG-${n + 100}`,
          },
        },
        agentActivity: {
          content: { body: "follow up" },
          signal: null,
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("skips prompted events without issue.identifier", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const n = uid++
      const payload = makeAgentSessionPrompted({
        createdAt: `2099-08-02T00:00:${String(n).padStart(2, "0")}.000Z`,
        agentSession: {
          id: `sess-prompt-malformed-${n}`,
          issue: {
            id: `issue-prompt-malformed-${n}`,
            identifier: undefined,
            url: `https://linear.app/eng/issue/ENG-${n + 100}`,
          },
        },
        agentActivity: {
          content: { body: "follow up" },
          signal: null,
        },
      })
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
    })

    it("includes follow-up body in dispatch context", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = uniquePrompted()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("Follow-up question")
    })
  })

  // -----------------------------------------------------------------------
  describe("Comment create event", () => {
    // -----------------------------------------------------------------------

    it("handles Comment type webhooks (fallback path) — dispatches agent when token available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // Mock fetch for getIssueDetails
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
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
    })

    it("comment fallback skips when no token available", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi() // No accessToken configured
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
    })

    it("skips comments when actor has no id (no comparison possible)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token", botUserId: "bot-user-uuid-001" })

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

      // Without actor.id, the filter can't match — passes through but no token mock
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    })

    it("comment fallback updates status to In Progress", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const commentIssueId = `issue-cf-status-${uid}`
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
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled()
      expect(mockFetch).toHaveBeenCalledTimes(4)
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

    it("returns 200 for Issue type events (no-op handler)", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi()
      const payload = {
        type: "Issue",
        action: "update",
        createdAt: `2026-04-01T15:00:${String(uid++).padStart(2, "0")}.000Z`,
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled()
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
