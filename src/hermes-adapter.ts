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
 *   hermes.webhookUrl: "http://hermes-host:8644/webhooks"
 *   hermes.webhookSecret: HMAC secret for signing payloads to Hermes
 *   hermes.routeName: "linear" (default)
 */

import { createHmac } from "node:crypto"
import type { Logger } from "./api/linear-api.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HermesConfig {
  webhookUrl: string
  webhookSecret: string
  routeName?: string
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Forward prompt to Hermes webhook
// ---------------------------------------------------------------------------

export async function dispatchToHermes(params: {
  issue: { id: string; identifier: string; title: string; description?: string | null; url?: string }
  body: string
  config: HermesConfig
  logger?: Logger
}): Promise<{ ok: boolean; error?: string }> {
  const { issue, body, config, logger } = params

  const routeName = config.routeName || "linear"
  const url = config.webhookUrl.endsWith("/") ? `${config.webhookUrl}${routeName}` : `${config.webhookUrl}/${routeName}`

  // Build payload that Hermes's webhook adapter will receive.
  // The prompt template in Hermes config extracts {prompt} from this.
  // The linear-workflow skill reads _linear_issue_id to post replies.
  const payload = {
    type: "Issue",
    action: "agent_trigger",
    prompt: body,
    _linear_issue_id: issue.id,
    _linear_identifier: issue.identifier,
    _linear_title: issue.title,
    _linear_url: issue.url,
  }

  const bodyStr = JSON.stringify(payload)
  const signature = createHmac("sha256", config.webhookSecret).update(bodyStr).digest("hex")

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

  if (!hermes.webhookSecret || typeof hermes.webhookSecret !== "string") {
    errors.push("hermes.webhookSecret is required when dispatchMode is 'hermes'")
  }

  if (errors.length > 0) {
    return { valid: false, hermesConfig: null, errors }
  }

  return {
    valid: true,
    hermesConfig: {
      webhookUrl: hermes.webhookUrl as string,
      webhookSecret: hermes.webhookSecret as string,
      routeName: (hermes.routeName as string) || undefined,
      timeoutMs: (hermes.timeoutMs as number) || undefined,
    },
    errors: [],
  }
}
