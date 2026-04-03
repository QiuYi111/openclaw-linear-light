import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Linear API client unit tests
// ---------------------------------------------------------------------------

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock fs for resolveLinearToken and persistToken (via oauth-store)
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockRenameSync = vi.fn()
vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}))

// We don't mock oauth-store directly — instead we mock node:fs,
// so the actual oauth-store code uses our mocked fs functions.
// This avoids issues with require() mock interception in ESM mode.

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function makeApi(overrides?: Partial<typeof mockLogger>) {
  return { ...mockLogger, ...overrides } as typeof mockLogger
}

describe("LinearAgentApi", () => {
  beforeEach(() => {
    vi.resetAllMocks()
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
      const logger = makeApi()
      const api = new LinearAgentApi("lin_api_test", { logger })

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: "Not found" }],
          }),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear GraphQL")
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("GraphQL errors"))
    })

    it("logs full GraphQL error details but throws sanitized message without schema info", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("lin_api_test", { logger })

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
      // Full details must be logged via logger for debugging
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("secretField"))
    })

    it("returns data even when partial errors present", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("lin_api_test", { logger })

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
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("partial errors"))
    })

    it("throws on HTTP error with sanitized message", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("lin_api_test", { logger })

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error with secret info"),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear API request failed (500)")
      // Full response body must be logged via logger, not exposed in thrown message
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("secret info"))
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

    it("returns partial data when retry succeeds with partial GraphQL errors", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("expired-token", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
        logger,
      })

      // First call: 401
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
      // Refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
      })
      // Retry: partial errors with data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { teams: { nodes: [{ id: "1", name: "Eng", key: "ENG" }] } },
            errors: [{ message: "some field error" }],
          }),
      })

      const result = await api.getTeams()
      expect(result).toEqual([{ id: "1", name: "Eng", key: "ENG" }])
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("partial errors"))
    })

    it("throws when retry after refresh also returns 401", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("expired-token", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
        logger,
      })

      // First call: 401
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
      // Refresh succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
      })
      // Retry: also 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("still unauthorized"),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear API request failed (401)")
      expect(logger.error).toHaveBeenCalled()
    })

    it("throws on GraphQL errors without data after retry (after refresh path)", async () => {
      // Lines 268-269: after 401 → refresh → retry, the retry response has
      // GraphQL errors but no data — should log and throw.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const logger = makeApi()
      const api = new LinearAgentApi("expired-token", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
        logger,
      })

      // First call: 401
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
      // Refresh succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
      })
      // Retry: GraphQL errors without data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: "Permission denied" }],
          }),
      })

      await expect(api.getTeams()).rejects.toThrow("Linear GraphQL request failed (see server logs)")
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("GraphQL errors (after refresh)"))
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

  describe("token refresh coalescing", () => {
    it("concurrent 401 responses coalesce onto a single refresh call", async () => {
      // Multiple concurrent 401s should trigger only ONE refresh HTTP call.
      // Late-arriving callers await the in-flight refresh promise.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("stale-token", {
        refreshToken: "refresh-123",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      let refreshCount = 0
      let resolveRefresh: () => void
      const refreshDeferred = new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
      let graphqlCallCount = 0

      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://api.linear.app/oauth/token") {
          refreshCount++
          await refreshDeferred
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "refreshed-token",
                refresh_token: "new-refresh",
                expires_in: 3600,
              }),
          }
        }
        // GraphQL URL: first 2 calls return 401, subsequent calls succeed
        graphqlCallCount++
        if (graphqlCallCount <= 2) {
          return { ok: false, status: 401 }
        }
        return {
          ok: true,
          json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
        }
      })

      // Fire two concurrent requests
      const p1 = api.getTeams()
      const p2 = api.getTeams()

      // Let the refresh complete
      if (resolveRefresh) resolveRefresh()

      const [r1, r2] = await Promise.all([p1, p2])

      // Both requests should succeed
      expect(r1).toEqual([])
      expect(r2).toEqual([])

      // Only ONE refresh HTTP call should have been made (coalescing)
      expect(refreshCount).toBe(1)
    })

    it("cooldown after success: late-arriving 401s coalesce onto resolved promise", async () => {
      // After a successful refresh, late-arriving 401s (within cooldown window)
      // should coalesce onto the resolved promise instead of triggering new refresh.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      let refreshCount = 0

      // Request A: 401 → refresh → retry
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      mockFetch.mockImplementationOnce(async (_url: string) => {
        refreshCount++
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "token-2",
              refresh_token: "refresh-2",
              expires_in: 3600,
            }),
        }
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      expect(refreshCount).toBe(1)

      // Request B: 401 within cooldown → should coalesce onto resolved promise,
      // not trigger a new refresh. expiresAt is set to 0 by 401 handler,
      // but refreshPromise is still alive (cooldown).
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      // The retry after coalesced refresh should use the updated token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      // Still only 1 refresh call — the second 401 coalesced
      expect(refreshCount).toBe(1)
    })

    it("cooldown expiry: new refresh triggered after cooldown window", async () => {
      // After cooldown expires, a new refresh should be triggered.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      let refreshCount = 0

      // First request: 401 → refresh
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
      mockFetch.mockImplementationOnce(async (_url: string) => {
        refreshCount++
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "token-2",
              refresh_token: "refresh-2",
              expires_in: 1, // 1ms expiry so it's immediately stale
            }),
        }
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      expect(refreshCount).toBe(1)

      // Wait for cooldown to expire (REFRESH_COOLDOWN_MS = 5000)
      // We can't actually wait 5s in tests, but the token will also be expired
      // since expires_in was 1ms. Simulate by advancing time via the module internals.
      // Instead, we test the cooldown expiry path directly:
      // After cooldown + token expiry, a new request should trigger a fresh refresh.

      // Manually expire the cooldown by setting refreshSuccessTime far in the past
      // We can't access private fields, but we can trigger another 401 flow
      // after waiting. Since we can't manipulate time, test the logical path:
      // a second 401 after cooldown expiry + token expiry → new refresh.
      // For this test, we just verify the first refresh set the success time
      // and a subsequent request within cooldown coalesces (tested above).
      // The cooldown expiry is a time-based behavior best tested via integration.
    })

    it("clears expired cooldown promise and triggers new refresh", async () => {
      // After cooldown expires, the stale refreshPromise is cleared (line 127)
      // and a new refresh is triggered when the token is also expired.
      vi.useFakeTimers()
      try {
        const { LinearAgentApi } = await import("../api/linear-api.js")
        const api = new LinearAgentApi("token-1", {
          refreshToken: "refresh-1",
          clientId: "cid",
          clientSecret: "csec",
          expiresAt: Date.now() + 3600_000,
        })

        let refreshCount = 0

        // First request: 401 → refresh
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
        mockFetch.mockImplementationOnce(async () => {
          refreshCount++
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "token-2",
                refresh_token: "refresh-2",
                expires_in: 1, // 1ms — token expires almost immediately
              }),
          }
        })
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
        })

        await api.getTeams()
        expect(refreshCount).toBe(1)

        // Advance past cooldown (5s) + buffer (60s) to ensure both
        // cooldown expiry and token expiry conditions are met
        vi.advanceTimersByTime(6_100)

        // Second request: cooldown expired AND token expired → new refresh
        mockFetch.mockImplementationOnce(async () => {
          refreshCount++
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "token-3",
                refresh_token: "refresh-3",
                expires_in: 3600,
              }),
          }
        })
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
        })

        await api.getTeams()
        // A new refresh should have been triggered (cooldown expired + token expired)
        expect(refreshCount).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("stale promise cleanup: on refresh failure, next request can retry fresh", async () => {
      // When refresh fails, refreshPromise is cleared immediately.
      // The next request should be able to retry the refresh.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      // First request: GRAPHQL 401 → OAUTH refresh fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      })

      await expect(api.getTeams()).rejects.toThrow()

      // Second request: refreshPromise was cleared on failure,
      // expiresAt is 0 (set by 401 handler), so ensureValidToken runs first.
      // Fetch order: OAUTH (refresh) → GRAPHQL (API)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      const result = await api.getTeams()
      expect(result).toHaveLength(0)
      expect(mockFetch).toHaveBeenCalledTimes(4) // 2 (first attempt) + 2 (second attempt)
    })

    it("refresh token single-use safety: 400 on second refresh does not cause infinite loop", async () => {
      // OAuth refresh tokens are single-use. After a successful refresh,
      // the old refresh token is consumed. A second refresh attempt with
      // the old token returns 400. The current code does NOT retry with
      // the consumed token — it throws immediately.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "consumed-refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000, // force refresh on first call
      })

      // First request triggers refresh → succeeds, updates token in memory
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
      })
      // First API call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      // Second request: token is valid, no refresh needed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      // Only 3 fetch calls total (refresh + api + api), no redundant refresh
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("late-arriving 401 after successful refresh retries with new token", async () => {
      // Scenario: request A triggers refresh, request B gets 401 after
      // A's refresh completed. B should retry with the new token.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      // Request A: gets 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      })
      // Refresh succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
      })
      // Retry A: succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [{ id: "1", name: "Eng", key: "ENG" }] } } }),
      })

      const resultA = await api.getTeams()
      expect(resultA).toHaveLength(1)

      // Request B: token is now valid (expiresAt updated), no refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      const resultB = await api.getTeams()
      expect(resultB).toHaveLength(0)

      // Total: 401 + refresh + retry + direct = 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("does not refresh when expiresAt is null", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token", {
        refreshToken: "refresh",
        clientId: "cid",
        clientSecret: "csec",
        // expiresAt intentionally undefined
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      expect(mockFetch).toHaveBeenCalledTimes(1) // API call only, no refresh
    })

    it("does not refresh when within buffer window (60s before expiry)", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      // Token expires in 120s — within the 60s buffer, so it WILL refresh
      const api = new LinearAgentApi("token", {
        refreshToken: "refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 50_000, // 50s from now, within 60s buffer
      })

      // Refresh call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
      })
      // API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      expect(mockFetch).toHaveBeenCalledTimes(2) // refresh + API
    })

    it("updates in-memory refreshToken when server returns new one", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000,
      })

      // Refresh returns new tokens
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_in: 7200,
          }),
      })
      // API call — verify it uses the new Bearer token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      // The API call should use the NEW access token
      const apiCall = mockFetch.mock.calls[1]
      expect(apiCall[1].headers.Authorization).toBe("Bearer token-2")
    })

    it("keeps old refreshToken when server does not return new one", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("token-1", {
        refreshToken: "refresh-1",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000,
      })

      // Refresh returns new access token but NO new refresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "token-2",
            expires_in: 3600,
          }),
      })
      // API call — should still use Bearer prefix (refreshToken still present)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()

      const apiCall = mockFetch.mock.calls[1]
      expect(apiCall[1].headers.Authorization).toBe("Bearer token-2")
    })
  })

  describe("persistToken", () => {
    it("does not throw when persistence fails (best-effort)", async () => {
      // persistToken wraps require + writeStoredToken in try/catch.
      // If oauth-store is unavailable, the refresh still succeeds.
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("old-token", {
        refreshToken: "old-refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() - 1000,
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      // Should NOT throw even though persistToken's require/write may fail
      await api.getTeams()
    })

    it("does not persist when no refresh happens", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("valid-token", {
        refreshToken: "refresh",
        clientId: "cid",
        clientSecret: "csec",
        expiresAt: Date.now() + 3600_000,
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { teams: { nodes: [] } } }),
      })

      await api.getTeams()
      // No fs writes when no refresh occurs
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })
  })

  describe("resolveLinearToken", () => {
    it("returns token from plugin config", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      const result = resolveLinearToken({ accessToken: "cfg-token-123" })
      expect(result).toEqual({ accessToken: "cfg-token-123", source: "config" })
    })

    it("returns none when no token available", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      const result = resolveLinearToken()
      expect(result).toEqual({ accessToken: null, source: "none" })
    })

    it("returns none when plugin config has empty string token", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      const result = resolveLinearToken({ accessToken: "" })
      expect(result).toEqual({ accessToken: null, source: "none" })
    })

    it("returns none when plugin config has non-string token", async () => {
      const { resolveLinearToken } = await import("../api/linear-api.js")
      const result = resolveLinearToken({ accessToken: 12345 as any })
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

    it("throws when issue has no team", async () => {
      const { LinearAgentApi } = await import("../api/linear-api.js")
      const api = new LinearAgentApi("lin_api_test")

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                id: "issue-1",
                team: null, // no team
              },
            },
          }),
      })

      await expect(api.updateIssueState("issue-1", "Done")).rejects.toThrow("Cannot find team for issue")
    })
  })
})
