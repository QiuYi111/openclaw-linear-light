/**
 * Plugin configuration validation with actionable error messages.
 *
 * Validates required and optional config fields at startup,
 * returning structured results with actionable guidance for users.
 */

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Validate plugin configuration and return actionable feedback.
 *
 * Checks:
 * - webhookSecret (required for webhook processing)
 * - linearClientId + linearClientSecret (required for OAuth)
 * - Optional fields get sensible defaults
 */
export function validateConfig(config: Record<string, unknown> | undefined): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config) {
    errors.push(
      "No plugin config found. " +
        "Add a 'linear-light' entry to your openclaw.config.json5 plugins.entries. " +
        "See https://github.com/QiuYi111/openclaw-linear-light#quick-start",
    )
    return { valid: false, errors, warnings }
  }

  if (!config.webhookSecret) {
    errors.push(
      "Missing webhookSecret. " +
        "Find it in Linear → Settings → API → OAuth Applications → [your app] → Webhook Signing Secret. " +
        "Then set it in your openclaw.config.json5 under plugins.entries.linear-light.config.webhookSecret.",
    )
  }

  if (!(config.linearClientId && config.linearClientSecret)) {
    warnings.push(
      "Missing linearClientId or linearClientSecret. " +
        "OAuth flow and automatic token refresh will be unavailable. " +
        "Find them in Linear → Settings → API → OAuth Applications → [your app].",
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
