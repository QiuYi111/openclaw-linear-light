import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyLinearSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const provided = signature.replace(/^sha256=/i, "")
  if (expected.length !== provided.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}
