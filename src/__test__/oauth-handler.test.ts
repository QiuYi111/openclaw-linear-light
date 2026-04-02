import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// OAuth handler unit tests
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock crypto for PKCE
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn((size: number) => ({
    toString: vi.fn(() => "a".repeat(size * 2)), // deterministic base64url-like string
  })),
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => "mock-challenge"),
    })),
  })),
}))

// Mock oauth-store
const mockWriteStoredToken = vi.fn()
vi.mock("../api/oauth-store.js", () => ({
  writeStoredToken: mockWriteStoredToken,
}))

function makeApi(configOverrides: Record<string, unknown> = {}) {
  return {
    pluginConfig: {
      enabled: true,
      linearClientId: "test-client-id",
      linearClientSecret: "test-client-secret",
      ...configOverrides,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as any
}

function makeReq(url: string, headers: Record<string, string> = {}) {
  return {
    url,
    headers: {
      host: "localhost:3000",
      "x-forwarded-proto": "https",
      ...headers,
    },
  }
}

function makeRes() {
  const res: any = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead: vi.fn((status: number, hdrs: Record<string, string>) => {
      res.statusCode = status
      res.headers = hdrs
    }),
    end: vi.fn((body?: string) => {
      res.body = body || ""
    }),
  }
  return res
}

describe("generateAuthorizationURL", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("generates a valid authorization URL with PKCE and actor=app", async () => {
    const { generateAuthorizationURL } = await import("../oauth-handler.js")
    const { url, state, codeVerifier } = generateAuthorizationURL("my-client", "https://example.com/callback")

    expect(url).toContain("https://linear.app/oauth/authorize")
    expect(url).toContain("client_id=my-client")
    expect(url).toContain("redirect_uri=")
    expect(url).toContain("response_type=code")
    expect(url).toContain("scope=read%2Cwrite")
    expect(url).toContain("state=")
    expect(url).toContain("code_challenge=mock-challenge")
    expect(url).toContain("code_challenge_method=S256")
    expect(url).toContain("actor=app")
    expect(state).toBeTruthy()
    expect(codeVerifier).toBeTruthy()
  })

  it("uses custom state and scopes when provided", async () => {
    const { generateAuthorizationURL } = await import("../oauth-handler.js")
    const { url, state } = generateAuthorizationURL("my-client", "https://example.com/callback", {
      state: "custom-state",
      scopes: "read",
    })

    expect(url).toContain("state=custom-state")
    expect(url).toContain("scope=read")
    expect(state).toBe("custom-state")
  })
})

describe("handleOAuthInit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("redirects to Linear authorize URL", async () => {
    const { handleOAuthInit } = await import("../oauth-handler.js")
    const api = makeApi()
    const req = makeReq("/linear-light/oauth/init")
    const res = makeRes()

    await handleOAuthInit(api, req, res)

    expect(res.statusCode).toBe(302)
    expect(res.headers.Location).toContain("https://linear.app/oauth/authorize")
  })

  it("returns 400 when clientId is not configured", async () => {
    const { handleOAuthInit } = await import("../oauth-handler.js")
    const api = makeApi({ linearClientId: undefined })
    delete process.env.LINEAR_CLIENT_ID
    const req = makeReq("/linear-light/oauth/init")
    const res = makeRes()

    await handleOAuthInit(api, req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain("linearClientId not configured")
  })
})

describe("handleOAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("exchanges code for tokens and stores them", async () => {
    const { handleOAuthCallback, generateAuthorizationURL } = await import("../oauth-handler.js")

    // First, generate a URL to create a pending state
    generateAuthorizationURL("test-client-id", "https://localhost:3000/linear-light/oauth/callback")

    // Mock the token exchange
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
    })

    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?code=test-code&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") // matches randomBytes(16).toString("hex") mock
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("OAuth Setup Complete")
    expect(mockWriteStoredToken).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "new-access",
        refreshToken: "new-refresh",
      }),
      expect.anything(), // logger passed as second arg
    )
  })

  it("returns 400 when OAuth error parameter is present", async () => {
    const { handleOAuthCallback } = await import("../oauth-handler.js")
    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?error=access_denied&state=test")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain("access_denied")
  })

  it("returns 400 when code or state is missing", async () => {
    const { handleOAuthCallback } = await import("../oauth-handler.js")
    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?code=only-code")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain("Missing code or state")
  })

  it("returns 400 for invalid or expired state", async () => {
    const { handleOAuthCallback } = await import("../oauth-handler.js")
    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?code=test-code&state=invalid-state")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain("Invalid or expired state")
  })

  it("returns 500 when clientId/clientSecret not configured", async () => {
    const { handleOAuthCallback, generateAuthorizationURL } = await import("../oauth-handler.js")

    generateAuthorizationURL("test-client-id", "https://localhost:3000/linear-light/oauth/callback")

    const api = makeApi({ linearClientId: undefined, linearClientSecret: undefined })
    delete process.env.LINEAR_CLIENT_ID
    delete process.env.LINEAR_CLIENT_SECRET

    const req = makeReq("/linear-light/oauth/callback?code=test-code&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toContain("Configuration Error")
  })

  it("returns 502 when token exchange fails", async () => {
    const { handleOAuthCallback, generateAuthorizationURL } = await import("../oauth-handler.js")

    generateAuthorizationURL("test-client-id", "https://localhost:3000/linear-light/oauth/callback")

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid_grant"),
    })

    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?code=bad-code&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(502)
    expect(res.body).toContain("Token Exchange Failed")
  })

  it("returns 500 on fetch exception", async () => {
    const { handleOAuthCallback, generateAuthorizationURL } = await import("../oauth-handler.js")

    generateAuthorizationURL("test-client-id", "https://localhost:3000/linear-light/oauth/callback")

    mockFetch.mockRejectedValueOnce(new Error("network error"))

    const api = makeApi()
    const req = makeReq("/linear-light/oauth/callback?code=test-code&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toContain("Internal Error")
  })

  it("uses the stored redirect URI from init, not the callback request headers", async () => {
    const { handleOAuthCallback, generateAuthorizationURL } = await import("../oauth-handler.js")

    // Init with one host
    generateAuthorizationURL("test-client-id", "https://original-host:8080/linear-light/oauth/callback")

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "tok",
          refresh_token: "ref",
          expires_in: 3600,
        }),
    })

    const api = makeApi()
    // Callback arrives via a different proxy/host — should still use the stored URI
    const req = makeReq("/linear-light/oauth/callback?code=test-code&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      host: "different-host:9090",
      "x-forwarded-proto": "http",
    })
    const res = makeRes()

    await handleOAuthCallback(api, req, res)

    expect(res.statusCode).toBe(200)
    // Verify the token exchange used the original redirect URI
    const fetchBody = mockFetch.mock.calls[0][1]?.body as URLSearchParams
    expect(fetchBody.get("redirect_uri")).toBe("https://original-host:8080/linear-light/oauth/callback")
  })
})
