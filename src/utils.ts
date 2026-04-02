/**
 * Utility functions
 */

/**
 * Sanitize user-controlled text before embedding in agent prompts.
 * Prevents token budget abuse and template variable injection.
 */
export function sanitizePromptInput(text: string, maxLength = 4000): string {
  if (!text) return "(no content)"
  let sanitized = text.slice(0, maxLength)
  sanitized = sanitized.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }")
  return sanitized
}
