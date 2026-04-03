import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Plugin entry point (index.ts) unit tests — channel-mode architecture
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

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

// Mock openclaw/plugin-sdk for createPluginRuntimeStore (used by runtime.ts)
vi.mock("openclaw/plugin-sdk", () => ({
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => null),
  })),
}))

// Mock getChatChannelMeta
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
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => null),
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
      ...configOverrides,
    },
    logger: mockLogger,
    registerHttpRoute: vi.fn(),
    registerTool: vi.fn(),
    registerChannel: vi.fn(),
    on: vi.fn(),
    runtime: {},
    config: {
      plugins: {
        entries: {
          "linear-light": {
            config: {
              accessToken: "lin_test_token",
            },
          },
        },
      },
    },
  } as any
}

describe("plugin register()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    expect(api.registerChannel).not.toHaveBeenCalled()
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

    // Webhook, channel, and tools should NOT be registered
    expect(paths).not.toContain("/linear-light/webhook")
    expect(api.registerTool).not.toHaveBeenCalled()
    expect(api.registerChannel).not.toHaveBeenCalled()
  })

  it("registers OAuth routes, webhook route, channel, tools, and lifecycle hooks", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)

    const paths = api.registerHttpRoute.mock.calls.map((call: any) => call[0].path)
    expect(paths).toContain("/linear-light/oauth/callback")
    expect(paths).toContain("/linear-light/oauth/init")
    expect(paths).toContain("/linear-light/webhook")
    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: expect.any(Object) })
    expect(api.registerTool).toHaveBeenCalled()

    // Lifecycle hooks
    const hookNames = api.on.mock.calls.map((call: any) => call[0])
    expect(hookNames).toContain("llm_output")
    expect(hookNames).toContain("before_tool_call")
    expect(hookNames).toContain("after_tool_call")
    expect(hookNames).toContain("agent_end")
  })

  it("registers 3 tools: linear_update_status, linear_get_issue, linear_search_issues", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)
    const toolNames = api.registerTool.mock.calls.map((call: any) => call[0].name)

    expect(toolNames).toContain("linear_update_status")
    expect(toolNames).toContain("linear_get_issue")
    expect(toolNames).toContain("linear_search_issues")
    expect(toolNames).toHaveLength(3)
  })

  it("registers channel plugin with correct id and capabilities", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)

    const channelArg = api.registerChannel.mock.calls[0][0]
    expect(channelArg.plugin.id).toBe("linear")
    expect(channelArg.plugin.capabilities.chatTypes).toEqual(["direct"])
    expect(channelArg.plugin.capabilities.media).toBe(false)
    expect(channelArg.plugin.capabilities.blockStreaming).toBe(false)
    expect(channelArg.plugin.outbound.deliveryMode).toBe("direct")
  })

  it("channel config lists single 'default' account", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)

    const channelArg = api.registerChannel.mock.calls[0][0]
    expect(channelArg.plugin.config.listAccountIds()).toEqual(["default"])
    expect(channelArg.plugin.config.defaultAccountId()).toBe("default")
    const account = channelArg.plugin.config.resolveAccount()
    expect(account.accountId).toBe("default")
    expect(account.configured).toBe(true)
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
    expect(result.content[0].text).toContain("Done")
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

  it("linear_search_issues tool returns search results", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            issueSearch: {
              nodes: [
                {
                  id: "i-1",
                  identifier: "ENG-1",
                  title: "First",
                  state: { name: "Todo" },
                  url: "https://example.com/1",
                },
                {
                  id: "i-2",
                  identifier: "ENG-2",
                  title: "Second",
                  state: { name: "Done" },
                  url: "https://example.com/2",
                },
              ],
            },
          },
        }),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const searchTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_search_issues")?.[0]
    expect(searchTool).toBeDefined()

    const result = await searchTool.execute("tc-search", { query: "test" })
    expect(result.content[0].text).toContain("ENG-1")
    expect(result.content[0].text).toContain("ENG-2")
  })

  it("linear_search_issues returns 'No issues found' for empty results", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { issueSearch: { nodes: [] } } }),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const searchTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_search_issues")?.[0]

    const result = await searchTool.execute("tc-search-empty", { query: "nonexistent" })
    expect(result.content[0].text).toBe("No issues found")
  })

  it("linear_search_issues error path returns failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server Error"),
    })

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const searchTool = api.registerTool.mock.calls.find((call: any) => call[0].name === "linear_search_issues")?.[0]

    const result = await searchTool.execute("tc-search-fail", { query: "fail" })
    expect(result.content[0].text).toContain("Failed")
    expect(result.details).toEqual({ status: "failed" })
  })
})

describe("outbound sendText", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sendText posts comment via createComment and returns ok", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // getChatChannelMeta mock returns meta
    // resolveIssueId calls gql — mock fetch for the identifier lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: { id: "resolved-uuid" } } }),
    })
    // createComment call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } }),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "ENG-42",
      text: "Hello from agent",
    } as any)

    expect(result.ok).toBe(true)
    expect(result.channel).toBe("linear")
  })

  it("sendText returns error when no access token", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: { plugins: { entries: {} } },
      to: "ENG-42",
      text: "Hello",
    } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("no access token")
  })

  it("sendText passes through UUID directly without gql call", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // Only createComment call — no resolveIssueId gql call for UUID
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-uuid" } } } }),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "550e8400-e29b-41d4-a716-446655440000",
      text: "Direct UUID test",
    } as any)

    expect(result.ok).toBe(true)
    // Only 1 fetch call (createComment), not 2 (no gql identifier lookup)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("sendText strips channel prefix from identifier", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // gql call for "ENG-42" (after prefix stripping from "linear:ENG-42")
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: { id: "resolved-uuid" } } }),
    })
    // createComment
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-prefix" } } } }),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "linear:ENG-42",
      text: "Prefix strip test",
    } as any)

    expect(result.ok).toBe(true)
    // 2 fetch calls: gql identifier lookup + createComment
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("sendText returns error when issue cannot be resolved", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // gql returns no issue
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: null } }),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "NONEXISTENT-99",
      text: "Should fail",
    } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("could not resolve issue")
  })

  it("sendText emits response activity when agentSessionId exists", async () => {
    const { agentSessionMap } = await import("../../index.js")
    agentSessionMap.set("resolved-uuid", "sess-emit-1")

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // gql identifier lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: { id: "resolved-uuid" } } }),
    })
    // createComment
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-emit" } } } }),
    })
    // emitActivity
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "ENG-42",
      text: "Activity test",
    } as any)

    expect(result.ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(3) // gql + createComment + emitActivity
    agentSessionMap.delete("resolved-uuid")
  })

  it("sendText handles emitActivity failure gracefully", async () => {
    const { agentSessionMap } = await import("../../index.js")
    agentSessionMap.set("resolved-uuid", "sess-emit-fail")

    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // gql identifier lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: { id: "resolved-uuid" } } }),
    })
    // createComment
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "c-emit-fail" } } } }),
    })
    // emitActivity fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Activity emit failed"),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "ENG-42",
      text: "Activity fail test",
    } as any)

    // Comment should still succeed even though emitActivity failed
    expect(result.ok).toBe(true)
    agentSessionMap.delete("resolved-uuid")
  })

  it("sendText handles API error gracefully", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()
    mod.default(api)

    // gql identifier lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { issue: { id: "resolved-uuid" } } }),
    })
    // createComment fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server Error"),
    })

    const channelArg = api.registerChannel.mock.calls[0][0]
    const result = await channelArg.plugin.outbound.sendText({
      cfg: api.config,
      to: "ENG-42",
      text: "Should fail",
    } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("500")
  })
})

describe("health endpoint /linear-light/status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns ok when fully configured", async () => {
    const mod = await import("../../index.js")
    const api = makeApi()

    mod.default(api)

    const statusRoute = api.registerHttpRoute.mock.calls.find(
      (call: any) => call[0].path === "/linear-light/status",
    )
    expect(statusRoute).toBeDefined()

    const res = { writeHead: vi.fn(), end: vi.fn() }
    await statusRoute[0].handler({}, res)

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }))
    const body = JSON.parse(res.end.mock.calls[0][0])
    expect(body.status).toBe("ok")
    expect(body.version).toBe("0.1.0")
    expect(body.configured.webhook).toBe(true)
    expect(body.configured.token).toBe(true)
  })

  it("returns degraded when no access token", async () => {
    const mod = await import("../../index.js")
    const api = makeApi({ accessToken: undefined })
    delete process.env.LINEAR_ACCESS_TOKEN
    delete process.env.LINEAR_API_KEY

    mod.default(api)

    const statusRoute = api.registerHttpRoute.mock.calls.find(
      (call: any) => call[0].path === "/linear-light/status",
    )

    const res = { writeHead: vi.fn(), end: vi.fn() }
    await statusRoute[0].handler({}, res)

    const body = JSON.parse(res.end.mock.calls[0][0])
    expect(body.status).toBe("degraded")
    expect(body.configured.token).toBe(false)
  })
})
