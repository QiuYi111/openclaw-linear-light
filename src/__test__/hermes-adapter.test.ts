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
      hermes: { webhookSecret: "secret" },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("hermes.webhookUrl is required when dispatchMode is 'hermes'")
  })

  it("returns errors when webhookSecret is missing", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: { webhookUrl: "http://localhost:8644" },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("hermes.webhookSecret is required when dispatchMode is 'hermes'")
  })

  it("returns valid hermesConfig when all required fields present", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: {
        webhookUrl: "http://localhost:8644/webhooks",
        webhookSecret: "my-secret",
        routeName: "linear",
        timeoutMs: 20000,
      },
    })
    expect(result.valid).toBe(true)
    expect(result.hermesConfig).toEqual({
      webhookUrl: "http://localhost:8644/webhooks",
      webhookSecret: "my-secret",
      routeName: "linear",
      timeoutMs: 20000,
    })
  })

  it("uses defaults for optional fields", () => {
    const result = validateHermesConfig({
      dispatchMode: "hermes",
      hermes: {
        webhookUrl: "http://localhost:8644/webhooks",
        webhookSecret: "secret",
      },
    })
    expect(result.hermesConfig?.routeName).toBeUndefined()
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
    webhookUrl: "http://localhost:8644/webhooks",
    webhookSecret: "test-secret",
    routeName: "linear",
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
    expect(url).toBe("http://localhost:8644/webhooks/linear")
    expect(options.method).toBe("POST")
    expect(options.headers["Content-Type"]).toBe("application/json")
    expect(options.headers["X-Hub-Signature-256"]).toMatch(/^sha256=[a-f0-9]+$/)

    const payload = JSON.parse(options.body)
    expect(payload._linear_issue_id).toBe("issue-uuid-001")
    expect(payload._linear_identifier).toBe("ENG-42")
    expect(payload.prompt).toBe("test prompt")
    expect(payload._linear_title).toBe("Test issue")
    expect(payload._linear_url).toBe("https://linear.app/test/issue/ENG-42")
  })

  it("appends route name without extra slash when URL ends with /", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const configWithSlash: HermesConfig = {
      webhookUrl: "http://localhost:8644/webhooks/",
      webhookSecret: "test-secret",
    }

    await dispatchToHermes({ issue, body: "test", config: configWithSlash, logger: mockLogger })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:8644/webhooks/linear")
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

  it("handles non-Error rejections", async () => {
    mockFetch.mockRejectedValue("string error")

    const result = await dispatchToHermes({ issue, body: "test", config, logger: mockLogger })

    expect(result.ok).toBe(false)
    expect(result.error).toBe("string error")
  })

  it("uses default route name 'linear' when not specified", async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const configNoRoute: HermesConfig = {
      webhookUrl: "http://localhost:8644/webhooks",
      webhookSecret: "test-secret",
    }

    await dispatchToHermes({ issue, body: "test", config: configNoRoute, logger: mockLogger })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:8644/webhooks/linear")
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
