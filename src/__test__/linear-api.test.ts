import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Linear API client unit tests
// ---------------------------------------------------------------------------

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock fs for resolveLinearToken
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockRenameSync = vi.fn()
vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}))

describe("LinearAgentApi", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("authHeader", () => {
    it("uses Bearer prefix when refreshToken is present (OAuth token)", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_oauth_test", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
      })

      // Make a request and check the Authorization header
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      const call = mockFetch.mock.calls[0]
      expect(call[1].headers.Authorization).toBe("Bearer lin_oauth_test")
    })

    it("uses raw token when no refreshToken (personal API key)", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_testkey")

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      const call = mockFetch.mock.calls[0]
      expect(call[1].headers.Authorization).toBe("lin_api_testkey")
    })
  })

  describe("GraphQL error handling", () => {
    it("throws on GraphQL errors without data", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: "Not found" }],
          }),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear GraphQL")
      errorSpy.mockRestore()
    })

    it("logs full GraphQL error details but throws sanitized message without schema info", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [
              {
                message: "Field 'secretField' does not exist on type 'User'",
                extensions: { userId: "user-secret-id-123" },
              },
            ],
          }),
      })

      const err = await api.getTeams().catch((e) => e)

      // Thrown message must not expose schema details or user IDs
      expect(err.message).not.toContain("secretField")
      expect(err.message).not.toContain("user-secret-id-123")
      // Full details must be logged to server console for debugging
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("secretField"))
      errorSpy.mockRestore()
    })

    it("returns data even when partial errors present", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { teams: { nodes: [{ id: "1", name: "Eng", key: "ENG" }] } },
            errors: [{ message: "partial field error" }],
          }),
      })

      const result = await api.getTeams()
      expect(result).toHaveLength(1)
      // Partial errors should be logged as warnings
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("partial errors"))
      warnSpy.mockRestore()
    })

    it("throws on HTTP error", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear API 500")
    })
  })

  describe("ensureValidToken", () => {
    it("does not refresh when token is not close to expiry", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_oauth_test", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000, // 1 hour from now
      })

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      // Should only have one fetch call (the actual API call, no refresh)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("refreshes token when expired", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_oauth_test", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000, // expired
      })

      // First call: refresh endpoint
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new_token",
            refresh_token: "new_refresh",
            expires_in: 3600,
          }),
      })
      // Second call: actual API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Verify refresh call
      const refreshCall = mockFetch.mock.calls[0]
      expect(refreshCall[0]).toBe("https://api.linear.app/oauth/token")
    })

    it("does not attempt refresh without clientId/clientSecret", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_oauth_test", {
        refreshToken: "refresh-123",
        expiresAt: Date.now() - 1000,
      })

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      // Only API call, no refresh
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("401 retry", () => {
    it("retries with fresh token on 401", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_oauth_test", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      // First call: 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      // Refresh call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "refreshed_token",
            refresh_token: "refreshed_refresh",
            expires_in: 3600,
          }),
      })
      // Retry call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      const result = await api.getTeams()
      expect(result).toEqual([])
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe("emitActivity", () => {
    it("posts an activity to an agent session", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { agentActivityCreate: { success: true } },
          }),
      })

      await api.emitActivity("session-1", { type: "thought", body: "thinking..." })
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const call = mockFetch.mock.calls[0]
      const body = JSON.parse(call[1].body)
      expect(body.query).toContain("agentActivityCreate")
      expect(body.variables.input.agentSessionId).toBe("session-1")
    })
  })

  describe("persistToken (cyrus source)", () => {
    it("writes refreshed token back to cyrus config", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")

      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          linearWorkspaces: {
            default: {
              linearToken: "old-token",
              linearRefreshToken: "old-refresh",
              linearTokenExpiresAt: Date.now() - 1000,
            },
          },
        }),
      )

      const api = new LinearAgentApi("old-token", {
        refreshToken: "old-refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000,
        source: "cyrus",
      })

      // Refresh call returns new token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
      })
      // Actual API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      // writeFileSync should write to a temp file, then renameSync for atomicity
      expect(mockWriteFileSync).toHaveBeenCalled()
      const writtenPath = mockWriteFileSync.mock.calls[0][0]
      expect(writtenPath).toMatch(/\.tmp$/)
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1])
      const ws = written.linearWorkspaces.default
      expect(ws.linearToken).toBe("new-access-token")
      expect(ws.linearRefreshToken).toBe("new-refresh-token")
      // rename from temp → final path for atomic persistence
      expect(mockRenameSync).toHaveBeenCalledWith(writtenPath, expect.stringMatching(/config\.json$/))
    })
  })

  describe("401 retry with refresh failure", () => {
    it("throws when 401 and refresh also fails", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("expired-token", {
        refreshToken: "old-refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      // First call: 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      // Refresh call: fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad refresh token"),
      })

      await expect(api.getTeams()).rejects.toThrow()
    })
  })

  describe("resolveLinearToken", () => {
    afterEach(() => {
      delete process.env.LINEAR_ACCESS_TOKEN
      delete process.env.LINEAR_API_KEY
    })

    it("returns token from plugin config", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      const result = resolveLinearToken({ accessToken: "cfg-token-123" })
      expect(result).toEqual({ accessToken: "cfg-token-123", source: "config" })
    })

    it("returns token from Cyrus config", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          linearWorkspaces: {
            default: {
              linearToken: "cyrus-token",
              linearRefreshToken: "cyrus-refresh",
              linearTokenExpiresAt: 1234567890,
            },
          },
        }),
      )

      const result = resolveLinearToken()
      expect(result.accessToken).toBe("cyrus-token")
      expect(result.source).toBe("cyrus")
      expect(result.refreshToken).toBe("cyrus-refresh")
    })

    it("returns token from env var as fallback", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      mockReadFileSync.mockImplementation(() => {
        throw new Error("no file")
      })
      process.env.LINEAR_ACCESS_TOKEN = "env-token"

      const result = resolveLinearToken()
      expect(result).toEqual({ accessToken: "env-token", source: "env" })
    })

    it("returns none when no token available", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      mockReadFileSync.mockImplementation(() => {
        throw new Error("no file")
      })

      const result = resolveLinearToken()
      expect(result).toEqual({ accessToken: null, source: "none" })
    })
  })

  describe("createComment", () => {
    it("posts a comment and returns comment id", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              commentCreate: {
                success: true,
                comment: { id: "comment-001" },
              },
            },
          }),
      })

      const id = await api.createComment("issue-1", "Hello world")
      expect(id).toBe("comment-001")
    })
  })

  describe("getIssueDetails", () => {
    it("returns issue with all fields", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      const issueData = {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Test issue",
        description: "A test",
        state: { name: "In Progress", type: "started" },
        creator: { name: "Alice", email: "alice@test.com" },
        assignee: { name: "Bob" },
        labels: { nodes: [{ id: "label-1", name: "bug" }] },
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        comments: { nodes: [] },
        project: null,
        url: "https://linear.app/eng/issue/ENG-42",
      }

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { issue: issueData } }),
      })

      const issue = await api.getIssueDetails("issue-1")
      expect(issue.identifier).toBe("ENG-42")
      expect(issue.team.key).toBe("ENG")
    })
  })

  describe("updateIssueState", () => {
    it("finds matching state by name and updates", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      // First call: getIssueDetails
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                identifier: "ENG-1",
                title: "Test",
                description: null,
                state: { name: "Todo", type: "unstarted" },
                team: { id: "team-1", key: "ENG", name: "Eng" },
                creator: null,
                assignee: null,
                labels: { nodes: [] },
                comments: { nodes: [] },
                project: null,
                url: "https://linear.app/eng/issue/ENG-1",
              },
            },
          }),
      })

      // Second call: get team states
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo", name: "Todo" },
                    { id: "state-in-progress", name: "In Progress" },
                    { id: "state-done", name: "Done" },
                  ],
                },
              },
            },
          }),
      })

      // Third call: update issue
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { issueUpdate: { success: true } },
          }),
      })

      const result = await api.updateIssueState("issue-1", "Done")
      expect(result).toBe(true)

      // Verify update mutation used correct state ID
      const updateCall = mockFetch.mock.calls[2]
      const body = JSON.parse(updateCall[1].body)
      expect(body.variables.input.stateId).toBe("state-done")
    })

    it("matches state name case-insensitively", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                team: { id: "team-1" },
              },
            },
          }),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              team: {
                states: {
                  nodes: [{ id: "state-1", name: "In Progress" }],
                },
              },
            },
          }),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { issueUpdate: { success: true } },
          }),
      })

      const result = await api.updateIssueState("issue-1", "in progress")
      expect(result).toBe(true)
    })

    it("throws when state not found", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                team: { id: "team-1" },
              },
            },
          }),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              team: {
                states: {
                  nodes: [{ id: "state-1", name: "Todo" }],
                },
              },
            },
          }),
      })

      await expect(api.updateIssueState("issue-1", "Nonexistent")).rejects.toThrow('State "Nonexistent" not found')
    })
  })
})
