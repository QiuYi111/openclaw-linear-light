/**
 * Hermes adapter for Linear Light
 *
 * Provides an alternative dispatch mode: instead of dispatching to OpenClaw's
 * internal agent, forwards formatted prompts to a Hermes Agent webhook endpoint.
 *
 * Hermes processes the prompt using its own agent pipeline. Replies to Linear
 * are handled by the Hermes "linear-workflow" skill, which posts comments
 * via Linear GraphQL API.
 *
 * Architecture:
 *   Linear webhook → this plugin → POST to Hermes webhook → Hermes agent processes
 *   Hermes agent → uses linear-workflow skill → posts comment to Linear
 *
 * Config:
 *   dispatchMode: "hermes"
 *   hermes.webhookUrl: "http://localhost:8644/linear/hermes" (full route URL)
 *   hermes.routeSecret: HMAC secret for signing payloads to this route
 *   hermes.timeoutMs: optional request timeout in ms (default: 15000)
 */

import { createHmac } from "node:crypto"
import type { Logger } from "./core/logger.js"
import type { LinearWebhookIssue } from "./core/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HermesConfig {
  /** Full webhook URL including route path, e.g. "http://localhost:8644/linear/hermes" */
  webhookUrl: string
  /** Route-specific HMAC signing secret */
  routeSecret: string
  /** Request timeout in milliseconds (default: 15000) */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Forward prompt to Hermes webhook
// ---------------------------------------------------------------------------

export async function dispatchToHermes(params: {
  issue: LinearWebhookIssue
  body: string
  projectDir?: string
  config: HermesConfig
  logger?: Logger
}): Promise<{ ok: boolean; error?: string }> {
  const { issue, body, projectDir, config, logger } = params

  const url = config.webhookUrl

  // Build payload that Hermes's webhook adapter will receive.
  // The prompt template in Hermes config extracts {prompt} from this.
  // The linear-workflow skill reads _linear_issue_id to post replies.
  const payload: Record<string, unknown> = {
    type: "Issue",
    action: "agent_trigger",
    prompt: body,
    _linear_issue_id: issue.id,
    _linear_identifier: issue.identifier,
    _linear_title: issue.title,
    _linear_url: issue.url,
  }

  if (projectDir) {
    payload._linear_project_dir = projectDir
  }

  const bodyStr = JSON.stringify(payload)
  const signature = createHmac("sha256", config.routeSecret).update(bodyStr).digest("hex")

  logger?.info(`Hermes adapter: dispatching to ${url} for ${issue.identifier}`)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 15_000)

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: bodyStr,
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      logger?.error(`Hermes adapter: ${response.status} from Hermes: ${text.slice(0, 200)}`)
      return { ok: false, error: `Hermes returned ${response.status}` }
    }

    logger?.info(`Hermes adapter: accepted for ${issue.identifier}`)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger?.error(`Hermes adapter: fetch failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export function validateHermesConfig(config: Record<string, unknown>): {
  valid: boolean
  hermesConfig: HermesConfig | null
  errors: string[]
} {
  const errors: string[] = []

  if (config.dispatchMode !== "hermes") {
    return { valid: true, hermesConfig: null, errors: [] }
  }

  const hermes = (config.hermes || {}) as Record<string, unknown>

  if (!hermes.webhookUrl || typeof hermes.webhookUrl !== "string") {
    errors.push("hermes.webhookUrl is required when dispatchMode is 'hermes'")
  }

  if (!hermes.routeSecret || typeof hermes.routeSecret !== "string") {
    errors.push("hermes.routeSecret is required when dispatchMode is 'hermes'")
  }

  if (errors.length > 0) {
    return { valid: false, hermesConfig: null, errors }
  }

  return {
    valid: true,
    hermesConfig: {
      webhookUrl: hermes.webhookUrl as string,
      routeSecret: hermes.routeSecret as string,
      timeoutMs: (hermes.timeoutMs as number) || undefined,
    },
    errors: [],
  }
}
