import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => null),
  })),
}))

describe("runtime", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("getLinearApi returns null before setLinearApi is called", async () => {
    const { getLinearApi } = await import("../runtime.js")
    expect(getLinearApi()).toBeNull()
  })

  it("setLinearApi and getLinearApi roundtrip", async () => {
    const { setLinearApi, getLinearApi } = await import("../runtime.js")
    const mockApi = { emitActivity: vi.fn() } as any
    setLinearApi(mockApi)
    expect(getLinearApi()).toBe(mockApi)
  })
})
