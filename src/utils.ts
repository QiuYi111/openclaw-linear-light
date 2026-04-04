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
  // Escape all brace-based template interpolation patterns to prevent injection
  sanitized = sanitized.replace(/\$\{([^}]*)\}/g, "$ { $1 }") // ${variable}
  sanitized = sanitized.replace(/%\{([^}]*)\}/g, "% { $1 }") // %{variable}
  sanitized = sanitized.replace(/\{\{/, "{ {") // {{variable}}
  sanitized = sanitized.replace(/\{([a-zA-Z_]\w*)\}/g, "{ $1 }") // {identifier}, {state}, etc.
  return sanitized
}
