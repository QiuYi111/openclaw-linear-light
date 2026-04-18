import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Watchdog unit tests
// ---------------------------------------------------------------------------

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock node:fs for FileTokenStore
const mockReadFileSync = vi.fn()
const mockExistsSync = vi.fn(() => true)
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: vi.fn(),
  readFileSync: mockReadFileSync,
  writeFileSync: vi.fn(),
}))

// Mock node:child_process for pm2 repair
const mockExecSync = vi.fn()
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}))

// Mock node:os homedir
vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}))

// Mock node:path
vi.mock("node:path", () => ({
  join: (...args: string[]) => args.join("/"),
  dirname: (p: string) => p.split("/").slice(0, -1).join("/") || ".",
}))

describe("runWatchdog", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default: network OK, token OK, gateway OK
    mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      const query = body?.query ?? ""

      // Network connectivity check (no auth header)
      if (!opts?.headers?.Authorization && query === "{ __typename }") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { __typename: "QueryRoot" } }),
        })
      }

      // Token validity check (with auth)
      if (query.includes("viewer")) {
        const auth = opts?.headers?.Authorization
        if (auth?.includes("valid-token")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: { viewer: { id: "user-1", name: "Test" } } }),
          })
        }
        return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve("Unauthorized") })
      }

      // Gateway health check
      if (url?.includes("/health")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok", uptime: 3600 }) })
      }

      return Promise.resolve({ ok: false, status: 404 })
    })

    // Default: token file exists with valid token
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 86400000,
      }),
    )
    mockExistsSync.mockReturnValue(true)
  })

  it("reports healthy when all checks pass", async () => {
    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    expect(report.healthy).toBe(true)
    expect(report.checks).toHaveLength(3)
    expect(report.checks[0].name).toBe("network")
    expect(report.checks[0].ok).toBe(true)
    expect(report.checks[1].name).toBe("token")
    expect(report.checks[1].ok).toBe(true)
    expect(report.checks[2].name).toBe("gateway")
    expect(report.checks[2].ok).toBe(true)
  })

  it("reports unhealthy when network is unreachable", async () => {
    mockFetch.mockImplementation(() => {
      const err = new Error("fetch failed")
      throw err
    })

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    expect(report.healthy).toBe(false)
    expect(report.checks).toHaveLength(1) // early exit after network failure
    expect(report.checks[0].name).toBe("network")
    expect(report.checks[0].ok).toBe(false)
  })

  it("reports unhealthy when token is expired", async () => {
    mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      const query = body?.query ?? ""

      if (!opts?.headers?.Authorization && query === "{ __typename }") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { __typename: "QueryRoot" } }),
        })
      }

      if (query.includes("viewer")) {
        return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve("Unauthorized") })
      }

      if (url?.includes("/health")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok", uptime: 3600 }) })
      }

      return Promise.resolve({ ok: false, status: 404 })
    })

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    expect(report.healthy).toBe(false)
    expect(report.checks.find((c) => c.name === "token")?.ok).toBe(false)
  })

  it("reports unhealthy when gateway is down", async () => {
    mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      const query = body?.query ?? ""

      if (!opts?.headers?.Authorization && query === "{ __typename }") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { __typename: "QueryRoot" } }),
        })
      }

      if (query.includes("viewer")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { viewer: { id: "user-1", name: "Test" } } }),
        })
      }

      if (url?.includes("/health")) {
        const err = new Error("ECONNREFUSED")
        throw err
      }

      return Promise.resolve({ ok: false, status: 404 })
    })

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    expect(report.healthy).toBe(false)
    expect(report.checks.find((c) => c.name === "gateway")?.ok).toBe(false)
  })

  it("attempts pm2 restart when gateway is down and --fix is set", async () => {
    mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      const query = body?.query ?? ""

      if (!opts?.headers?.Authorization && query === "{ __typename }") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { __typename: "QueryRoot" } }),
        })
      }

      if (query.includes("viewer")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { viewer: { id: "user-1", name: "Test" } } }),
        })
      }

      if (url?.includes("/health")) {
        const err = new Error("ECONNREFUSED")
        throw err
      }

      return Promise.resolve({ ok: false, status: 404 })
    })

    mockExecSync.mockReturnValue(Buffer.from("restarted"))

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({ fix: true })

    expect(report.healthy).toBe(false)
    const gatewayCheck = report.checks.find((c) => c.name === "gateway")
    expect(gatewayCheck?.repaired).toBe(true)
    expect(mockExecSync).toHaveBeenCalledWith("pm2 restart linear-gateway", expect.any(Object))
  })

  it("uses custom port when provided", async () => {
    const { runWatchdog } = await import("../standalone/watchdog.js")
    await runWatchdog({ port: 9091 })

    // Check that one of the fetch calls used the custom port
    const healthCall = mockFetch.mock.calls.find((call: unknown[]) => String(call[0]).includes("/health"))
    expect(healthCall?.[0]).toContain("9091")
  })

  it("reports no token when token store is empty", async () => {
    mockReadFileSync.mockReturnValue("{}")

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    expect(report.healthy).toBe(false)
    const tokenCheck = report.checks.find((c) => c.name === "token")
    expect(tokenCheck?.ok).toBe(false)
    expect(tokenCheck?.detail).toContain("no token found")
  })

  it("skips token and gateway checks when network is down (early exit)", async () => {
    mockFetch.mockImplementation((_url: string, opts?: { body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      const query = body?.query ?? ""

      // Network check returns 401 (reachable but unauthenticated — fine for network check)
      if (!opts?.headers?.Authorization && query === "{ __typename }") {
        return Promise.resolve({ ok: false, status: 503 })
      }

      // If we get here, the test is wrong
      throw new Error("Should not reach token/gateway checks")
    })

    const { runWatchdog } = await import("../standalone/watchdog.js")
    const report = await runWatchdog({})

    // Network 503 is not 200/401, so it should report unhealthy and early-exit
    expect(report.healthy).toBe(false)
    expect(report.checks).toHaveLength(1)
  })
})
