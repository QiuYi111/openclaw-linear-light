import { describe, expect, it } from "vitest"
import { validateConfig } from "../config-validation"

// ---------------------------------------------------------------------------
// Config validation unit tests
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  it("returns valid for a complete config", () => {
    const result = validateConfig({
      webhookSecret: "wh-secret",
      linearClientId: "client-id",
      linearClientSecret: "client-secret",
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("returns invalid with actionable message when webhookSecret is missing", () => {
    const result = validateConfig({
      linearClientId: "client-id",
      linearClientSecret: "client-secret",
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("webhookSecret")
    expect(result.errors[0]).toContain("Linear → Settings → API")
  })

  it("returns warning when OAuth credentials are missing", () => {
    const result = validateConfig({
      webhookSecret: "wh-secret",
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("linearClientId")
    expect(result.warnings[0]).toContain("OAuth")
  })

  it("returns warning when only linearClientId is set (missing secret)", () => {
    const result = validateConfig({
      webhookSecret: "wh-secret",
      linearClientId: "client-id",
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
  })

  it("returns invalid when config is null", () => {
    const result = validateConfig(null as any)

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("openclaw.config.json5")
  })

  it("returns invalid when config is undefined", () => {
    const result = validateConfig(undefined)

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("No plugin config found")
  })

  it("returns both error and warning when webhookSecret and OAuth creds are missing", () => {
    const result = validateConfig({ mentionTrigger: "Bot" })

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
  })

  it("treats empty string as missing for webhookSecret", () => {
    const result = validateConfig({
      webhookSecret: "",
      linearClientId: "client-id",
      linearClientSecret: "client-secret",
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  it("validates correctly with empty linearClientId (missing OAuth)", () => {
    const result = validateConfig({
      webhookSecret: "wh-secret",
      linearClientId: "",
      linearClientSecret: "client-secret",
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("linearClientId")
  })

  it("validates correctly with empty linearClientSecret (missing OAuth)", () => {
    const result = validateConfig({
      webhookSecret: "wh-secret",
      linearClientId: "client-id",
      linearClientSecret: "",
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("linearClientSecret")
  })
})
