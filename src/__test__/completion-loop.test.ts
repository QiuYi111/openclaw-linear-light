import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Completion loop tests
// ---------------------------------------------------------------------------

const mockGetLinearApi = vi.fn()
const mockDispatchFn = vi.fn().mockResolvedValue(undefined)

vi.mock("../runtime.js", () => ({
  getLinearApi: (...args: any[]) => mockGetLinearApi(...args),
}))

vi.mock("../../index.js", () => ({
  agentSessionMap: new Map(),
}))

async function importFresh() {
  vi.resetModules()
  vi.doMock("../runtime.js", () => ({
    getLinearApi: (...args: any[]) => mockGetLinearApi(...args),
  }))
  vi.doMock("../../index.js", () => ({
    agentSessionMap: new Map(),
  }))
  return await import("../completion-loop.js")
}

describe("completion-loop", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetLinearApi.mockReturnValue({
      getIssueDetails: vi.fn().mockResolvedValue({
        state: { name: "In Progress" },
      }),
    })
    mockDispatchFn.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("startCompletionLoop", () => {
    it("starts a loop that ticks after the configured interval", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 }) // 5 minutes

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      expect(mod.isCompletionLoopActive("issue-1")).toBe(true)
      expect(mod.getActiveLoopCount()).toBe(1)

      // Before interval — no tick
      expect(mockGetLinearApi).not.toHaveBeenCalled()

      // Advance to trigger exactly one tick — the tick will check state (In Progress)
      // and re-schedule, but stopCompletionLoop will prevent further ticks
      vi.advanceTimersByTime(5 * 60_000)
      // Flush the microtask queue for the async tick
      await vi.advanceTimersByTimeAsync(0)

      expect(mockGetLinearApi).toHaveBeenCalled()
      mod.stopAllCompletionLoops()
    })

    it("replaces existing loop when started again for same issue", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 10 })

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      // Should still be 1 loop
      expect(mod.getActiveLoopCount()).toBe(1)
      mod.stopAllCompletionLoops()
    })
  })

  describe("stopCompletionLoop", () => {
    it("stops an active loop", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 10 })

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      expect(mod.isCompletionLoopActive("issue-1")).toBe(true)

      mod.stopCompletionLoop("issue-1")

      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
    })

    it("does nothing when no loop exists", async () => {
      const mod = await importFresh()
      expect(() => mod.stopCompletionLoop("nonexistent")).not.toThrow()
    })

    it("stops all loops", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 10 })

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })
      mod.startCompletionLoop({
        issueId: "issue-2",
        issueIdentifier: "ENG-43",
        sessionKey: "agent:main:linear:direct:ENG-43",
      })

      expect(mod.getActiveLoopCount()).toBe(2)

      mod.stopAllCompletionLoops()

      expect(mod.getActiveLoopCount()).toBe(0)
    })
  })

  describe("loop behavior", () => {
    it("dispatches prompt when issue is not in terminal state", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })
      mod.setCompletionLoopDispatcher(mockDispatchFn)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      // Tick once — issue is In Progress, should dispatch
      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockDispatchFn).toHaveBeenCalledWith("issue-1", "ENG-42", expect.stringContaining("ENG-42"))
      mod.stopAllCompletionLoops()
    })

    it("stops loop when issue reaches Done state", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })

      const mockApi = {
        getIssueDetails: vi.fn().mockResolvedValue({ state: { name: "Done" } }),
      }
      mockGetLinearApi.mockReturnValue(mockApi)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
    })

    it("stops loop when issue reaches Canceled state", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })

      const mockApi = {
        getIssueDetails: vi.fn().mockResolvedValue({ state: { name: "Canceled" } }),
      }
      mockGetLinearApi.mockReturnValue(mockApi)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
    })

    it("continues loop for non-terminal states (case insensitive)", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })
      mod.setCompletionLoopDispatcher(mockDispatchFn)

      const mockApi = {
        getIssueDetails: vi.fn().mockResolvedValue({ state: { name: "In Review" } }),
      }
      mockGetLinearApi.mockReturnValue(mockApi)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mod.isCompletionLoopActive("issue-1")).toBe(true)
      expect(mockDispatchFn).toHaveBeenCalled()
      mod.stopAllCompletionLoops()
    })

    it("stops loop after max iterations", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 1, completionLoopMaxIterations: 2 })
      mod.setCompletionLoopDispatcher(mockDispatchFn)

      const mockApi = {
        getIssueDetails: vi.fn().mockResolvedValue({ state: { name: "In Progress" } }),
      }
      mockGetLinearApi.mockReturnValue(mockApi)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      // Tick 1 — after 1 minute, should dispatch
      vi.advanceTimersByTime(60_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockDispatchFn.mock.calls.length).toBeGreaterThanOrEqual(1)

      // Tick 2 — after another minute, should dispatch again and hit max
      vi.advanceTimersByTime(60_000)
      await vi.advanceTimersByTimeAsync(0)

      // No more ticks — loop stopped due to max iterations
      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
    })

    it("uses custom prompt template with placeholders", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({
        completionLoopInterval: 5,
        completionLoopPrompt: "Continue working on {identifier} (state: {state}, iter: {iteration})",
      })
      mod.setCompletionLoopDispatcher(mockDispatchFn)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockDispatchFn).toHaveBeenCalledWith(
        "issue-1",
        "ENG-42",
        "Continue working on ENG-42 (state: In Progress, iter: 1)",
      )
      mod.stopAllCompletionLoops()
    })
  })

  describe("disabled via config", () => {
    it("does not start loop when completionLoopEnabled is false", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopEnabled: false, completionLoopInterval: 5 })

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
    })
  })

  describe("error handling", () => {
    it("continues loop when API call fails", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })
      mod.setCompletionLoopDispatcher(mockDispatchFn)

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

      const mockApi = {
        getIssueDetails: vi.fn().mockRejectedValue(new Error("network error")),
      }
      mockGetLinearApi.mockReturnValue(mockApi)

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      // Loop should still be active after error
      expect(mod.isCompletionLoopActive("issue-1")).toBe(true)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
      mod.stopAllCompletionLoops()
    })

    it("stops loop when no Linear API available", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 5 })

      mockGetLinearApi.mockReturnValue(null)

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

      mod.startCompletionLoop({
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        sessionKey: "agent:main:linear:direct:ENG-42",
      })

      vi.advanceTimersByTime(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mod.isCompletionLoopActive("issue-1")).toBe(false)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe("getConfig", () => {
    it("returns default config when no plugin config set", async () => {
      const mod = await importFresh()
      const config = mod.getConfig()

      expect(config.enabled).toBe(true)
      expect(config.intervalMs).toBe(10 * 60_000)
      expect(config.maxIterations).toBe(0)
    })

    it("respects custom interval", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 3 })
      const config = mod.getConfig()

      expect(config.intervalMs).toBe(3 * 60_000)
    })

    it("enforces minimum interval of 1 minute", async () => {
      const mod = await importFresh()
      mod.setCompletionLoopConfig({ completionLoopInterval: 0 })
      const config = mod.getConfig()

      expect(config.intervalMs).toBe(60_000)
    })
  })
})
