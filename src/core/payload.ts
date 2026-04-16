import type { IncomingMessage, LinearWebhookPayload } from "./types.js"

// ---------------------------------------------------------------------------
// Webhook dedup tracking
// ---------------------------------------------------------------------------

const recentlyProcessed = new Map<string, number>()
const DEDUP_TTL_MS = 60_000
let lastSweep = Date.now()

export function wasRecentlyProcessed(key: string): boolean {
  const now = Date.now()
  if (now - lastSweep > 10_000) {
    for (const [k, ts] of recentlyProcessed) {
      if (now - ts > DEDUP_TTL_MS) recentlyProcessed.delete(k)
    }
    lastSweep = now
  }
  if (recentlyProcessed.has(key)) return true
  recentlyProcessed.set(key, now)
  return false
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

export async function readBody(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<{ ok: boolean; body?: LinearWebhookPayload; rawBuffer?: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ ok: false, error: "timeout" })
      }
    }, 5000)
    req.on("data", (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: "too large" })
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const rawBuffer = Buffer.concat(chunks)
        resolve({ ok: true, body: JSON.parse(rawBuffer.toString("utf8")), rawBuffer })
      } catch {
        resolve({ ok: false, error: "invalid json" })
      }
    })
    req.on("error", () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: "read error" })
      }
    })
  })
}
