import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Plugin entry point (index.ts) unit tests
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const mockSubagentRun = vi.fn().mockResolvedValue(undefined)
const mockSendMessageTelegram = vi.fn().mockResolvedValue(undefined)

// Mock fs for token resolution
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("no file")
  }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}))

// Mock oauth-store — return null by default (no stored token)
vi.mock("../../src/api/oauth-store.js", () => ({
  readStoredToken: vi.fn(() => null),
  writeStoredToken: vi.fn(),
}))

// Mock crypto for webhook signature
vi.mock("node:crypto", () => ({
  createHmac: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => "test-digest"),
    })),
  })),
  timingSafeEqual: vi.fn(() => true),
  randomBytes: vi.fn((size: number) => ({
    toString: vi.fn(() => "a".repeat(size * 2)),
  })),
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => "mock-challenge"),
    })),
  })),
}))

// Mock fetch for Linear API calls
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeApi(configOverrides: Record<string, unknown> = {}) {
  return {
    pluginConfig: {
      enabled: true,
      accessToken: "lin_test_token",
      webhookSecret: "test-secret",
      mentionTrigger: "Linus",
      autoInProgress: true,
      notifyOnComplete: true,
      notificationChannel: "telegram",
      notificationTarget: "12345",
      sessionPrefix: "linear:",
      ...configOverrides,
    },
    logger: mockLogger,
    registerHttpRoute: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    runtime: {
      subagent: {
        run: mockSubagentRun,
      },
      channel: {
        sendMessageTelegram: mockSendMessageTelegram,
      },
    },
  } as any
}

/**
 * Set up mock fetch responses for updateIssueState flow:
 *   getIssueDetails → getTeamStates → issueUpdate
 * Optionally followed by getIssueDetails for notification.
 */
function mockStatusUpdateFlow(extraIssueFields: Record<string, unknown> = {}) {
  mockFetch
    // getIssueDetails (for updateIssueState)
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-uuid-001",
              identifier: "ENG-42",
              title: "Test Issue",
              team: { id: "team-001", key: "ENG", name: "Engineering" },
              ...extraIssueFields,
            },
          },
        }),
    })
    // getTeamStates
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-todo", name: "Todo" },
                  { id: "state-done", name: "Done" },
                ],
              },
            },
          },
        }),
    })
    // issueUpdate mutation
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { issueUpdate: { success: true } },
        }),
    })
}

describe("plugin register()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubagentRun.mockResolvedValue(undefined)
    mockSendMessageTelegram.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
    })
  })

  it("skips registration when disabled", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ enabled: false })
    mod.default(api)

    expect(api.registerHttpRoute).not.toHaveBeenCalled()
    expect(api.registerTool).not.toHaveBeenCalled()
  })

  it("warns and skips webhook/tools when no access token, but registers OAuth routes", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ enabled: true, accessToken: undefined })
    delete process.env.LINEAR_ACCESS_TOKEN
    delete process.env.LINEAR_API_KEY

    mod.default(api)
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("no access token"))

    // OAuth routes should still be registered
    const paths = api.registerHttpRoute.mock.calls.map((call: any) => call[0].path)
    expect(paths).toContain("/linear-light/oauth/callback")
    expect(paths).toContain("/linear-light/oauth/init")

    // Webhook and tools should NOT be registered
    expect(paths).not.toContain("/linear-light/webhook")
    expect(api.registerTool).not.toHaveBeenCalled()
  })

  it("registers OAuth routes, webhook route, tools, and lifecycle hook", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)

    const paths = api.registerHttpRoute.mock.calls.map((call: any) => call[0].path)
    expect(paths).toContain("/linear-light/oauth/callback")
    expect(paths).toContain("/linear-light/oauth/init")
    expect(paths).toContain("/linear-light/webhook")
    expect(api.registerTool).toHaveBeenCalled()
    expect(api.registerHook).toHaveBeenCalledWith("subagent_ended", expect.any(Function))
  })

  it("registers 3 tools: linear_comment, linear_update_status, linear_get_issue", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)
    const toolNames = api.registerTool.mock.calls.map((call: any) => call[0].name)

    expect(toolNames).toContain("linear_comment")
    expect(toolNames).toContain("linear_update_status")
    expect(toolNames).toContain("linear_get_issue")
    expect(toolNames).toHaveLength(3)
  })
})

describe("onSubagentEnded", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubagentRun.mockResolvedValue(undefined)
    mockSendMessageTelegram.mockResolvedValue(undefined)
  })

  it("ignores non-linear session keys", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "slack:channel-1", success: true })

    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("updates status and sends notification on success", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    mockStatusUpdateFlow()
    // getIssueDetails for notification
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-uuid-001",
              identifier: "ENG-42",
              title: "Test Issue",
              url: "https://linear.app/eng/issue/ENG-42",
            },
          },
        }),
    })

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-uuid-001", success: true })

    expect(mockSendMessageTelegram).toHaveBeenCalledWith("12345", expect.stringContaining("ENG-42"), { silent: true })
  })

  it("does not send notification when notifyOnComplete is false", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ notifyOnComplete: false })
    mod.default(api)

    mockStatusUpdateFlow()

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-uuid-001", success: true })

    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("uses sessionPrefix from config", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ sessionPrefix: "custom:" })
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]

    // linear: prefix should NOT match when config uses custom:
    await hook({ sessionKey: "linear:issue-1", success: true })
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()

    // custom: prefix should match
    mockStatusUpdateFlow()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-1",
              identifier: "X-1",
              title: "T",
              url: "https://linear.app/x/X-1",
            },
          },
        }),
    })

    await hook({ sessionKey: "custom:issue-uuid-001", success: true })
    expect(mockSendMessageTelegram).toHaveBeenCalled()
  })
})

describe("registered route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
    })
  })

  it("invokes handleOAuthCallback via registered route handler", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // Find the callback route handler
    const callbackRoute = api.registerHttpRoute.mock.calls.find(
      (call: any) => call[0].path === "/linear-light/oauth/callback",
    )
    expect(callbackRoute).toBeDefined()

    const req = { url: "/linear-light/oauth/callback?error=access_denied", headers: { host: "localhost" } }
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await callbackRoute[0].handler(req, res)

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
  })

  it("invokes handleOAuthInit via registered route handler", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ linearClientId: "test-client-id", linearClientSecret: "test-client-secret" })
    mod.default(api)

    // Find the init route handler
    const initRoute = api.registerHttpRoute.mock.calls.find((call: any) => call[0].path === "/linear-light/oauth/init")
    expect(initRoute).toBeDefined()

    const req = { url: "/linear-light/oauth/init", headers: { host: "localhost", "x-forwarded-proto": "https" } }
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await initRoute[0].handler(req, res)

    expect(res.writeHead).toHaveBeenCalledWith(302, expect.any(Object))
  })

  it("invokes handleWebhook via registered route handler", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // Find the webhook route handler
    const webhookRoute = api.registerHttpRoute.mock.calls.find((call: any) => call[0].path === "/linear-light/webhook")
    expect(webhookRoute).toBeDefined()

    // Missing signature → 401
    const req = {
      url: "/linear-light/webhook",
      headers: {},
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === "end") cb()
      }),
    }
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await webhookRoute[0].handler(req, res)

    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object))
  })
})

describe("tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("linear_comment tool posts a comment", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { commentCreate: { success: true, comment: { id: "c-1" } } },
        }),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const commentTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_comment")?.[0]
    expect(commentTool).toBeDefined()

    const result = await commentTool.execute("tc-1", { issueId: "issue-1", body: "Test comment" })
    expect(result.content[0].text).toContain("issue-1")
  })

  it("tools are not registered when no access token", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ accessToken: "" })
    delete process.env.LINEAR_ACCESS_TOKEN
    delete process.env.LINEAR_API_KEY

    mod.default(api)
    expect(api.registerTool).not.toHaveBeenCalled()
  })

  it("linear_update_status tool updates issue state", async () => {
    // Mock fetch for updateIssueState flow (3 calls)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                team: { id: "team-1", key: "ENG", name: "Eng" },
              },
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { team: { states: { nodes: [{ id: "s-done", name: "Done" }] } } },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const statusTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_update_status")?.[0]
    expect(statusTool).toBeDefined()

    const result = await statusTool.execute("tc-2", { issueId: "issue-1", status: "Done" })
    expect(result.content[0].text).toContain("issue-1")
    expect(result.content[0].text).toContain("Done")
  })

  it("linear_get_issue tool returns issue details", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-1",
              identifier: "ENG-42",
              title: "Test issue",
              description: "A test issue",
              state: { name: "In Progress", type: "started" },
              creator: null,
              assignee: null,
              labels: { nodes: [] },
              team: { id: "team-1", key: "ENG", name: "Eng" },
              comments: { nodes: [] },
              project: null,
              url: "https://linear.app/eng/issue/ENG-42",
            },
          },
        }),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const getTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_get_issue")?.[0]
    expect(getTool).toBeDefined()

    const result = await getTool.execute("tc-3", { issueId: "issue-1" })
    expect(result.content[0].text).toContain("ENG-42")
  })

  it("tool execute handles API errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const commentTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_comment")?.[0]

    const result = await commentTool.execute("tc-4", { issueId: "issue-1", body: "fail test" })
    expect(result.content[0].text).toContain("Failed")
    expect(result.details).toEqual({ status: "failed" })
  })

  it("linear_comment emits response activity when agentSessionId exists", async () => {
    const { agentSessionMap } = await import("../../src/webhook-handler.js")
    agentSessionMap.set("issue-emit-1", "sess-emit-1")

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { commentCreate: { success: true, comment: { id: "c-emit" } } },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const commentTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_comment")?.[0]
    const result = await commentTool.execute("tc-emit", { issueId: "issue-emit-1", body: "Activity test" })

    expect(result.content[0].text).toContain("issue-emit-1")
    expect(mockFetch).toHaveBeenCalledTimes(2) // createComment + emitActivity
    agentSessionMap.delete("issue-emit-1")
  })

  it("linear_comment emits error activity when comment fails and agentSessionId exists", async () => {
    const { agentSessionMap } = await import("../../src/webhook-handler.js")
    agentSessionMap.set("issue-err-1", "sess-err-1")

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const commentTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_comment")?.[0]
    const result = await commentTool.execute("tc-err", { issueId: "issue-err-1", body: "fail" })

    expect(result.content[0].text).toContain("Failed")
    expect(result.details).toEqual({ status: "failed" })
    expect(mockFetch).toHaveBeenCalledTimes(2) // createComment failed + emitActivity error
    agentSessionMap.delete("issue-err-1")
  })

  it("linear_comment handles emitActivity failure gracefully on success path (catch block)", async () => {
    const { agentSessionMap } = await import("../../src/webhook-handler.js")
    agentSessionMap.set("issue-emit-fail-1", "sess-emit-fail-1")

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { commentCreate: { success: true, comment: { id: "c-emit-fail" } } },
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Activity emit failed"),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const commentTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_comment")?.[0]
    const result = await commentTool.execute("tc-emit-fail", {
      issueId: "issue-emit-fail-1",
      body: "Activity fail test",
    })

    // Comment should still succeed even though emitActivity failed
    expect(result.content[0].text).toContain("issue-emit-fail-1")
    expect(mockFetch).toHaveBeenCalledTimes(2) // createComment + emitActivity failure
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to emit activity"))
    agentSessionMap.delete("issue-emit-fail-1")
  })

  it("linear_update_status error path returns failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server Error"),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const statusTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_update_status")?.[0]

    const result = await statusTool.execute("tc-5", { issueId: "issue-1", status: "Done" })
    expect(result.content[0].text).toContain("Failed")
    expect(result.details).toEqual({ status: "failed" })
  })

  it("linear_get_issue error path returns failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const getTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_get_issue")?.[0]

    const result = await getTool.execute("tc-6", { issueId: "issue-nonexistent" })
    expect(result.content[0].text).toContain("Failed")
    expect(result.details).toEqual({ status: "failed" })
  })

  it("onSubagentEnded handles notification failure gracefully", async () => {
    mockFetch
      // getIssueDetails for updateIssueState
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: { id: "issue-1", team: { id: "team-1" } },
            },
          }),
      })
      // getTeamStates
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { team: { states: { nodes: [{ id: "s-done", name: "Done" }] } } },
          }),
      })
      // issueUpdate
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      })
      // getIssueDetails for notification (FAILS)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    // Should NOT throw even when notification fetch fails
    await hook({ sessionKey: "linear:issue-1", success: true })
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("onSubagentEnded skips when success is false", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-1", success: false })

    // Should not update status or send notification (no agentSessionId in map)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("onSubagentEnded emits error activity when session fails with agentSessionId", async () => {
    const { agentSessionMap } = await import("../../src/webhook-handler.js")
    agentSessionMap.set("issue-fail-1", "sess-fail-1")

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-fail-1", success: false })

    expect(mockFetch).toHaveBeenCalledTimes(1) // emitActivity error
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
    // agentSessionMap should be cleaned up in finally
    expect(agentSessionMap.has("issue-fail-1")).toBe(false)
  })

  it("onSubagentEnded skips when no runtime channel", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { issue: { id: "issue-1", team: { id: "team-1" } } },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { team: { states: { nodes: [{ id: "s-done", name: "Done" }] } } },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                identifier: "ENG-1",
                title: "Test",
                url: "https://linear.app/eng/issue/ENG-1",
              },
            },
          }),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    // Remove runtime.channel
    api.runtime.channel = undefined
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-1", success: true })

    // Status update should happen but notification should be skipped
    expect(mockFetch).toHaveBeenCalled()
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("uses default sessionPrefix 'linear:' when not configured in onSubagentEnded", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ sessionPrefix: undefined })
    mod.default(api)

    mockStatusUpdateFlow()
    // getIssueDetails for notification
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-uuid-001",
              identifier: "ENG-42",
              title: "Test Issue",
              url: "https://linear.app/eng/issue/ENG-42",
            },
          },
        }),
    })

    const hook = api.registerHook.mock.calls[0][1]
    // Without sessionPrefix config, default "linear:" is used
    await hook({ sessionKey: "linear:issue-uuid-001", success: true })

    expect(mockSendMessageTelegram).toHaveBeenCalled()
  })

  it("onSubagentEnded returns early when sessionKey equals prefix (empty issueId)", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ sessionPrefix: "custom:" })
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    // sessionKey is exactly the prefix — no issueId after slicing
    await hook({ sessionKey: "custom:", success: true })

    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("onSubagentEnded skips notification when channel exists but has no sendMessageTelegram", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    api.runtime.channel = { sendMessage: vi.fn() } as any // no sendMessageTelegram
    mod.default(api)

    mockStatusUpdateFlow()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issue: {
              id: "issue-uuid-001",
              identifier: "ENG-42",
              title: "Test Issue",
              url: "https://linear.app/eng/issue/ENG-42",
            },
          },
        }),
    })

    const hook = api.registerHook.mock.calls[0][1]
    await hook({ sessionKey: "linear:issue-uuid-001", success: true })

    // Status update happened, but notification was skipped (no sendMessageTelegram)
    expect(mockFetch).toHaveBeenCalled()
    expect(mockSendMessageTelegram).not.toHaveBeenCalled()
  })

  it("onSubagentEnded outer catch triggers when logger.warn throws inside notification catch", async () => {
    // The outer catch at line 273 is reached when an error propagates
    // out of the inner try/catch blocks. We simulate this by making
    // logger.warn throw inside the notification error handler.
    const throwingLogger = {
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error("logger exploded")
      }),
      error: vi.fn(),
      debug: vi.fn(),
    }

    mockFetch
      // getIssueDetails for updateIssueState
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { issue: { id: "issue-1", team: { id: "team-1" } } },
          }),
      })
      // getTeamStates
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { team: { states: { nodes: [{ id: "s-done", name: "Done" }] } } },
          }),
      })
      // issueUpdate
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      })
      // getIssueDetails for notification — FAILS
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      })

    const mod = await import("../../index.js")
    const api = makeApi()
    api.logger = throwingLogger
    mod.default(api)

    const hook = api.registerHook.mock.calls[0][1]
    // Should NOT throw even when inner catch's logger.warn propagates
    await hook({ sessionKey: "linear:issue-1", success: true })

    // The outer catch should have logged the error
    expect(throwingLogger.error).toHaveBeenCalledWith(expect.stringContaining("onSubagentEnded failed"))
  })
})
