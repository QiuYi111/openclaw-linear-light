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

const mockExistsSync = vi.fn().mockReturnValue(true)
const mockMkdirSync = vi.fn()
const mockRenameSync = vi.fn()

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: vi.fn(() => {
    throw new Error("no file")
  }),
  writeFileSync: vi.fn(),
  renameSync: mockRenameSync,
}))

vi.mock("openclaw/plugin-sdk", () => ({
  dispatchInboundReplyWithBase: (...args: any[]) => mockDispatchInboundReplyWithBase(...args),
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => null),
  })),
}))

// Controllable mock for getLinearApi — tests can set mockLinearApiReturnValue to null
let mockLinearApiReturnValue: any = null
vi.mock("../runtime.js", () => ({
  getLinearRuntime: vi.fn(() => mockRuntime),
  getLinearApi: vi.fn(() => mockLinearApiReturnValue),
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

const mockLinearApi = {
  updateIssueState: vi.fn().mockResolvedValue(undefined),
  emitActivity: vi.fn().mockResolvedValue(undefined),
  createComment: vi.fn().mockResolvedValue("comment-1"),
  getIssueDetails: vi.fn().mockResolvedValue({
    id: "issue-1",
    identifier: "ENG-42",
    title: "Test",
    description: null,
    url: "https://linear.app/test/ENG-42",
  }),
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
    mockLinearApiReturnValue = mockLinearApi
    mockDispatchInboundReplyWithBase.mockResolvedValue(undefined)
    mockFetch.mockReset()
    mockLinearApi.updateIssueState.mockResolvedValue(undefined)
    mockLinearApi.emitActivity.mockResolvedValue(undefined)
    mockLinearApi.createComment.mockResolvedValue("comment-1")
    mockLinearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-42",
      title: "Test",
      description: null,
      url: "https://linear.app/test/ENG-42",
    })
    mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue({
      agentId: "agent-main",
      sessionKey: "agent:main:linear:direct:ENG-42",
      accountId: "default",
      model: "default",
    })
    mockRuntime.channel.session.resolveStorePath.mockReturnValue("/tmp/store/agent-main")
    mockRuntime.channel.reply.finalizeInboundContext.mockImplementation((ctx: any) => ctx)
    mockExistsSync.mockReturnValue(true)
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

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      // updateIssueState and emitActivity called via shared mockLinearApi
      expect(mockLinearApi.updateIssueState).toHaveBeenCalledWith(payload.agentSession.issue.id, "In Progress")
      expect(mockLinearApi.emitActivity).toHaveBeenCalledWith(
        payload.agentSession.id,
        expect.objectContaining({ type: "response" }),
      )
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

    it("handles autoInProgress failure gracefully", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockLinearApi.updateIssueState.mockRejectedValueOnce(new Error("update failed"))
      mockLinearApi.emitActivity.mockRejectedValueOnce(new Error("emit failed"))

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

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Get the deliver callback from the dispatch call
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: "Agent reply text" })

      expect(mockLinearApi.createComment).toHaveBeenCalledWith(payload.agentSession.issue.id, "Agent reply text")
    })

    it("deliver callback logs error when createComment fails", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockLinearApi.createComment.mockRejectedValueOnce(new Error("Server Error"))

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

      mockLinearApi.createComment.mockClear()

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      await dispatchCall.deliver({ text: undefined })

      // No createComment call should be made for empty text
      expect(mockLinearApi.createComment).not.toHaveBeenCalled()
    })

    it("deliver callback logs error when no shared api instance", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")

      mockLinearApiReturnValue = null

      const api = makeApi({ autoInProgress: false, accessToken: "lin_test_token" })
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

    it("comment fallback skips when no shared api instance", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")

      mockLinearApiReturnValue = null

      const api = makeApi({ accessToken: "lin_test_token" })
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

      mockLinearApi.getIssueDetails.mockRejectedValueOnce(new Error("fetch failed"))

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
      expect(mockLinearApi.getIssueDetails).toHaveBeenCalledWith(commentIssueId)
      expect(mockLinearApi.updateIssueState).toHaveBeenCalledWith(commentIssueId, "In Progress")
    })
  })

  // -----------------------------------------------------------------------
  describe("project context injection", () => {
    // -----------------------------------------------------------------------

    it("includes project context in session created when issue has a project", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockLinearApi.getIssueDetails.mockReset()
      mockLinearApi.getIssueDetails.mockResolvedValue({
        id: "issue-1",
        identifier: "ENG-42",
        title: "Test",
        description: null,
        url: "https://linear.app/test/ENG-42",
        project: { id: "proj-1", name: "My Project" },
      })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("Project memory")
      expect(dispatchCall.ctxPayload.Body).toContain("AGENTS.md")
      expect(dispatchCall.ctxPayload.Body).toContain("follow its rules strictly")
    })

    it("omits project context when issue has no project", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // Default mock has no project field — project should be omitted
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).not.toContain("Project memory")
    })

    it("omits project context when projectMemoryEnabled is false", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token", projectMemoryEnabled: false })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).not.toContain("Project memory")
      // getIssueDetails should not be called for project context when disabled
      expect(mockLinearApi.getIssueDetails).not.toHaveBeenCalled()
    })

    it("includes project context in comment create fallback", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      const commentIssueId = `issue-proj-${uid}`
      mockLinearApi.getIssueDetails.mockReset()
      mockLinearApi.getIssueDetails.mockResolvedValue({
        id: commentIssueId,
        identifier: "ENG-99",
        title: "Comment Project Test",
        description: "Test project in comment fallback",
        url: "https://linear.app/test/ENG-99",
        project: { id: "proj-2", name: "Backend API" },
      })

      const payload = {
        type: "Comment",
        action: "create",
        createdAt: `2026-04-01T20:00:${String(uid++).padStart(2, "0")}.000Z`,
        data: {
          id: `comment-proj-${uid}`,
          body: "@Linus check this project",
          issue: { id: commentIssueId },
        },
      }
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("Project memory")
    })

    it("gracefully handles getIssueDetails failure for project context", async () => {
      const { handleWebhook } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      mockLinearApi.getIssueDetails.mockReset()
      mockLinearApi.getIssueDetails.mockRejectedValue(new Error("network error"))

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)

      await handleWebhook(api, req, res)

      // Should still succeed — project context is best-effort
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to resolve project context"))
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).not.toContain("Project memory")
    })

    it("includes project update instructions in completion loop prompt", async () => {
      const { handleWebhook, dispatchCompletionPrompt } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token" })

      // First, handle a webhook to capture dispatch context
      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req, res)

      // Set up getIssueDetails to return project info for completion loop
      mockLinearApi.getIssueDetails.mockReset()
      mockLinearApi.getIssueDetails.mockResolvedValue({
        id: payload.agentSession.issue.id,
        identifier: "ENG-42",
        title: "Test",
        description: null,
        url: "https://linear.app/test/ENG-42",
        project: { id: "proj-1", name: "My Project" },
      })

      mockDispatchInboundReplyWithBase.mockClear()

      await dispatchCompletionPrompt(payload.agentSession.issue.id, "ENG-42", "check status")

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledTimes(1)
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).toContain("Context.md")
      expect(dispatchCall.ctxPayload.Body).toContain("issues/ENG-42.md")
      expect(dispatchCall.ctxPayload.Body).toContain("Linear API")
    })

    it("omits project update instructions when projectMemoryEnabled is false", async () => {
      const { handleWebhook, dispatchCompletionPrompt } = await import("../webhook-handler.js")
      const api = makeApi({ accessToken: "lin_test_token", projectMemoryEnabled: false })

      const payload = uniqueCreated()
      const { req, res } = makeSignedReq(payload, SECRET)
      await handleWebhook(api, req, res)

      mockDispatchInboundReplyWithBase.mockClear()

      await dispatchCompletionPrompt(payload.agentSession.issue.id, "ENG-42", "check status")

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledTimes(1)
      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0]
      expect(dispatchCall.ctxPayload.Body).not.toContain("Context.md")
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
// dispatchCompletionPrompt tests — per-issue context isolation
// ---------------------------------------------------------------------------

describe("dispatchCompletionPrompt", () => {
  const SECRET = "wh-secret-test-123"
  let uid = 1

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  function makeApi(config: Record<string, unknown> = {}) {
    return {
      pluginConfig: {
        enabled: true,
        webhookSecret: SECRET,
        mentionTrigger: "Linus",
        autoInProgress: false,
        ...config,
      },
      logger: mockLogger,
      config: {},
      runtime: mockRuntime,
    } as any
  }

  function uniqueCreated(overrides?: Record<string, unknown>) {
    const n = uid++
    return makeAgentSessionCreated({
      createdAt: `2026-04-01T12:00:${String(n).padStart(2, "0")}.000Z`,
      agentSession: {
        id: `sess-dc-${n}`,
        issue: {
          id: `issue-dc-${n}`,
          identifier: `ENG-${n + 100}`,
          title: `DC issue ${n}`,
          description: `Description for DC issue ${n}`,
          url: `https://linear.app/eng/issue/ENG-${n + 100}`,
          team: { id: "team-001", key: "ENG", name: "Engineering" },
        },
      },
      ...overrides,
    })
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

  it("uses per-issue context when multiple issues are handled concurrently", async () => {
    const { dispatchCompletionPrompt, handleWebhook } = await import("../webhook-handler.js")

    const api1 = makeApi({ customMarker: "api-1" })
    const api2 = makeApi({ customMarker: "api-2" })

    // Handle webhook for issue 1
    const payload1 = uniqueCreated()
    const { req: req1, res: res1 } = makeSignedReq(payload1, SECRET)
    await handleWebhook(api1, req1, res1)

    // Handle webhook for issue 2 — would overwrite singleton in old code
    const payload2 = uniqueCreated()
    const { req: req2, res: res2 } = makeSignedReq(payload2, SECRET)
    await handleWebhook(api2, req2, res2)

    mockDispatchInboundReplyWithBase.mockClear()

    // Dispatch completion prompt for issue 1 — should use api1's context
    await dispatchCompletionPrompt(payload1.agentSession.issue.id, "ENG-999", "check status")

    expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledTimes(1)

    // Dispatch completion prompt for issue 2 — should use api2's context
    mockDispatchInboundReplyWithBase.mockClear()
    await dispatchCompletionPrompt(payload2.agentSession.issue.id, "ENG-998", "check status")

    expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledTimes(1)
  })

  it("warns and skips when no context captured for an issue", async () => {
    const { dispatchCompletionPrompt } = await import("../webhook-handler.js")

    // _logger may have been replaced by a previous test's handleWebhook call,
    // so spy on the mock logger's warn method if available, otherwise console.warn
    const warnSpy = vi.fn()
    mockLogger.warn.mockImplementation(warnSpy)

    await dispatchCompletionPrompt("nonexistent-issue", "ENG-000", "check")

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no API context captured for ENG-000"))
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
    expect(sanitizePromptInput("hello {{world}}")).toBe("hello { { world }}")
  })

  it("escapes dollar-brace template literals", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("use ${variable} here")).toBe("use $ { variable } here")
  })

  it("escapes percent-brace patterns", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("use %{variable} here")).toBe("use % { variable } here")
  })

  it("escapes single-brace identifier patterns", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("{identifier} is in {state}")).toBe("{ identifier } is in { state }")
    expect(sanitizePromptInput("{iteration} remaining")).toBe("{ iteration } remaining")
  })

  it("does not escape non-identifier braces", async () => {
    const { sanitizePromptInput } = await import("../utils.js")
    expect(sanitizePromptInput("{3} items")).toBe("{3} items")
    expect(sanitizePromptInput("{ }")).toBe("{ }")
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
