/**
 * OAuth authorization flow handler for Linear Light.
 *
 * Provides:
 * - handleOAuthInit: starts the OAuth flow (redirects to Linear authorize URL with PKCE)
 * - handleOAuthCallback: exchanges authorization code for tokens, stores them locally
 */

import { createHash, randomBytes } from "node:crypto"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"

import { writeStoredToken } from "./api/oauth-store.js"

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
const DEFAULT_SCOPES = "read,write"

// In-flight PKCE state for CSRF protection
const pendingStates = new Map<string, { codeVerifier: string; expiresAt: number }>()
const STATE_TTL_MS = 600_000 // 10 minutes

function cleanupExpiredStates(): void {
  const now = Date.now()
  for (const [key, val] of pendingStates) {
    if (now > val.expiresAt) pendingStates.delete(key)
  }
}

/**
 * Read query string from a stream-based request URL.
 */
function getQueryParams(req: any): Record<string, string> {
  const url = req.url as string
  const qIndex = url.indexOf("?")
  if (qIndex === -1) return {}
  const search = url.slice(qIndex + 1)
  const params: Record<string, string> = {}
  for (const pair of search.split("&")) {
    const eqIndex = pair.indexOf("=")
    if (eqIndex === -1) continue
    params[decodeURIComponent(pair.slice(0, eqIndex))] = decodeURIComponent(pair.slice(eqIndex + 1))
  }
  return params
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  return { codeVerifier, codeChallenge }
}

/**
 * Generate the Linear OAuth authorization URL with PKCE.
 */
export function generateAuthorizationURL(
  clientId: string,
  redirectUri: string,
  opts?: { scopes?: string; state?: string },
): { url: string; state: string; codeVerifier: string } {
  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = opts?.state || randomBytes(16).toString("hex")
  const scopes = opts?.scopes || DEFAULT_SCOPES

  // Store PKCE verifier for callback validation
  pendingStates.set(state, {
    codeVerifier,
    expiresAt: Date.now() + STATE_TTL_MS,
  })

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    actor: "app",
  })

  return {
    url: `${LINEAR_AUTHORIZE_URL}?${params.toString()}`,
    state,
    codeVerifier,
  }
}

/**
 * Handle OAuth init — redirect the user to Linear's authorization page.
 * Route: GET /linear-light/oauth/init
 */
export async function handleOAuthInit(api: OpenClawPluginApi, req: any, res: any): Promise<void> {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const clientId = (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID

  if (!clientId) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "linearClientId not configured" }))
    return
  }

  // Build redirect URI from the request host
  const proto = req.headers["x-forwarded-proto"] || "https"
  const host = req.headers.host || "localhost"
  const redirectUri = `${proto}://${host}/linear-light/oauth/callback`

  const { url, state } = generateAuthorizationURL(clientId, redirectUri)

  api.logger.info(`Linear Light: OAuth init, state=${state.slice(0, 8)}...`)
  res.writeHead(302, { Location: url })
  res.end()
}

/**
 * Handle OAuth callback — exchange authorization code for tokens.
 * Route: GET /linear-light/oauth/callback
 */
export async function handleOAuthCallback(api: OpenClawPluginApi, req: any, res: any): Promise<void> {
  const config = api.pluginConfig as Record<string, unknown> | undefined
  const params = getQueryParams(req)

  const { code, state, error } = params

  if (error) {
    api.logger.error(`Linear Light: OAuth callback error: ${error}`)
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(`<h1>OAuth Error</h1><p>${escapeHtml(error)}</p>`)
    return
  }

  if (!(code && state)) {
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end("<h1>OAuth Error</h1><p>Missing code or state parameter.</p>")
    return
  }

  // Validate state (CSRF protection)
  cleanupExpiredStates()
  const pending = pendingStates.get(state)
  if (!pending) {
    api.logger.error("Linear Light: OAuth callback with invalid or expired state")
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end("<h1>OAuth Error</h1><p>Invalid or expired state parameter.</p>")
    return
  }
  pendingStates.delete(state)

  const clientId = (config?.linearClientId as string) || process.env.LINEAR_CLIENT_ID
  const clientSecret = (config?.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET

  if (!(clientId && clientSecret)) {
    api.logger.error("Linear Light: OAuth callback but clientId/clientSecret not configured")
    res.writeHead(500, { "Content-Type": "text/html" })
    res.end("<h1>Configuration Error</h1><p>linearClientId and linearClientSecret must be configured.</p>")
    return
  }

  // Build redirect URI (must match the one used in init)
  const proto = req.headers["x-forwarded-proto"] || "https"
  const host = req.headers.host || "localhost"
  const redirectUri = `${proto}://${host}/linear-light/oauth/callback`

  // Exchange code for tokens
  try {
    const tokenRes = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: pending.codeVerifier,
      }),
    })

    if (!tokenRes.ok) {
      const errorBody = await tokenRes.text()
      api.logger.error(`Linear Light: token exchange failed (${tokenRes.status}): ${errorBody}`)
      res.writeHead(502, { "Content-Type": "text/html" })
      res.end(`<h1>Token Exchange Failed</h1><p>Linear returned ${tokenRes.status}.</p>`)
      return
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    // Store tokens in plugin-local storage
    writeStoredToken(
      {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
      },
      api.logger,
    )

    api.logger.info("Linear Light: OAuth token obtained and stored successfully")

    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(`
      <h1>OAuth Setup Complete</h1>
      <p>Linear Light is now connected. You can close this page.</p>
      <script>window.close()</script>
    `)
  } catch (err) {
    api.logger.error(`Linear Light: OAuth callback exception: ${err}`)
    res.writeHead(500, { "Content-Type": "text/html" })
    res.end("<h1>Internal Error</h1><p>Failed to complete OAuth flow.</p>")
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
