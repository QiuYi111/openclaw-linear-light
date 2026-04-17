import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Hermes adapter unit tests
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const mockFetch = vi.fn()

vi.stubGlobal("fetch", mockFetch)

import type { HermesConfig } from "../hermes-adapter.js"
import { dispatchToHermes, validateHermesConfig } from "../hermes-adapter.js"

// ---------------------------------------------------------------------------
// validateHermesConfig
// ---------------------------------------------------------------------------

describe("validateHermesConfig", () => {
  it("returns null hermesConfig when dispatchMode is not hermes", () => {
    const result = validateHermesConfig({ dispatchMode: "openclaw" })
    expect(result.valid).toBe(true)
    expect(result.hermesConfig).toBeNull()
    expect(result.errors).toEqual([])
  })

  it("returns errors when webhookUrl is missing", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: { routeSecret: "secret" },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("hermes.webhookUrl is required when dispatchMode is 'hermes'")
  })

  it("returns errors when routeSecret is missing", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: { webhookUrl: "http://localhost:8644/linear/hermes" },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("hermes.routeSecret is required when dispatchMode is 'hermes'")
  })

  it("returns valid hermesConfig when all required fields present", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: {
        webhookUrl: "http://localhost:8644/linear/hermes",
        routeSecret: "my-secret",
        timeoutMs: 20000,
      },
    })
    expect(result.valid).toBe(true)
    expect(result.hermesConfig).toEqual({
      webhookUrl: "http://localhost:8644/linear/hermes",
      routeSecret: "my-secret",
      timeoutMs: 20000,
    })
  })

  it("uses defaults for optional fields", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: {
        webhookUrl: "http://localhost:8644/linear/hermes",
        routeSecret: "secret",
      },
    })
    expect(result.hermesConfig?.timeoutMs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dispatchToHermes
// ---------------------------------------------------------------------------

describe("dispatchToHermes", () => {
  const issue = {
    id: "issue-uuid-001",
    identifier: "ENG-42",
    title: "Test issue",
    description: "Test description",
    url: "https://linear.app/test/issue/ENG-42",
  }

  const config: HermesConfig = {
    webhookUrl: "http://localhost:8644/linear/hermes",
    routeSecret: "test-secret",
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockLogger.info.mockReset()
    mockLogger.error.mockReset()
  })

  it("POSTs to Hermes with correct URL, payload, and HMAC signature", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const result = await dispatchToHermes({ issue, body: "test prompt", config, logger: mockLogger })

    expect(result.ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledOnce()

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:8644/linear/hermes")
    expect(options.method).toBe("POST")
    expect(options.headers["Content-Type"]).toBe("application/json")
    expect(options.headers["X-Linear-Signature"]).toMatch(/^sha256=[a-f0-9]+$/)

    const payload = JSON.parse(options.body)
    expect(payload._linear_issue_id).toBe("issue-uuid-001")
    expect(payload._linear_identifier).toBe("ENG-42")
    expect(payload.prompt).toBe("test prompt")
    expect(payload._linear_title).toBe("Test issue")
    expect(payload._linear_url).toBe("https://linear.app/test/issue/ENG-42")
  })

  it("uses X-Linear-Signature header (not X-Hub-Signature-256)", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    await dispatchToHermes({ issue, body: "test", config, logger: mockLogger })

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers["X-Linear-Signature"]).toBeDefined()
    expect(options.headers["X-Hub-Signature-256"]).toBeUndefined()
  })

  it("signs with routeSecret (not a global webhookSecret)", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const customConfig: HermesConfig = {
      webhookUrl: "http://localhost:8644/linear/hermes",
      routeSecret: "route-specific-secret-key",
    }

    await dispatchToHermes({ issue, body: "test", config: customConfig, logger: mockLogger })

    const [, options] = mockFetch.mock.calls[0]
    const headerSig = options.headers["X-Linear-Signature"] as string
    const expectedSig = createHmac("sha256", "route-specific-secret-key").update(options.body).digest("hex")
    expect(headerSig).toBe(`sha256=${expectedSig}`)
  })

  it("uses webhookUrl directly as the full path (no route name appending)", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const customConfig: HermesConfig = {
      webhookUrl: "http://hermes.example.com:9000/linear/hermes",
      routeSecret: "secret",
    }

    await dispatchToHermes({ issue, body: "test", config: customConfig, logger: mockLogger })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe("http://hermes.example.com:9000/linear/hermes")
  })

  it("returns error when Hermes returns non-OK", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") })

    const result = await dispatchToHermes({ issue, body: "test", config, logger: mockLogger })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("401")
  })

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))

    const result = await dispatchToHermes({ issue, body: "test", config, logger: mockLogger })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("ECONNREFUSED")
  })

  it("payload does not include callback-related fields", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    await dispatchToHermes({ issue, body: "test", config, logger: mockLogger })

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(payload).not.toHaveProperty("callbackBaseUrl")
    expect(payload).not.toHaveProperty("callbackUrl")
    // Should have Linear metadata for the skill
    expect(payload).toHaveProperty("_linear_issue_id")
    expect(payload).toHaveProperty("_linear_identifier")
    expect(payload).toHaveProperty("_linear_title")
    expect(payload).toHaveProperty("_linear_url")
    expect(payload).toHaveProperty("prompt")
  })
})
