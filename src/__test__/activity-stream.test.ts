import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Activity stream tests
// ---------------------------------------------------------------------------

const mockEmitActivity = vi.fn()
const mockGetLinearApi = vi.fn()
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("activity-stream", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    mockGetLinearApi.mockReturnValue({ emitActivity: mockEmitActivity })
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function importFresh() {
    vi.resetModules()
    // Re-establish mocks after module reset
    vi.doMock("../runtime.js", () => ({
      getLinearApi: (...args: any[]) => mockGetLinearApi(...args),
    }))
    vi.doMock("../../index.js", () => ({
      agentSessionMap: new Map([["issue-uuid-001", "linear-session-123"]]),
      identifierSessionMap: new Map([["DEV-163", "linear-session-123"]]),
    }))
    return await import("../activity-stream.js")
  }

  function makeCtx(sessionKey = "agent:main:linear:direct:DEV-163") {
    return { sessionKey }
  }

  describe("onLlmOutput", () => {
    it("ignores non-linear sessions", async () => {
      const { onLlmOutput } = await importFresh()

      await onLlmOutput({ assistantTexts: ["some text"], runId: "r1", sessionId: "s1" }, { sessionKey: "slack:xxx" })

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("ignores sessions not in agentSessionMap", async () => {
      const { onLlmOutput } = await importFresh()

      await onLlmOutput(
        { assistantTexts: ["some text"], runId: "r1", sessionId: "s1" },
        { sessionKey: "agent:main:linear:direct:UNKNOWN-999" },
      )

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("ignores empty texts", async () => {
      const { onLlmOutput } = await importFresh()

      await onLlmOutput({ assistantTexts: [], runId: "r1", sessionId: "s1" }, makeCtx())

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("handles null last text in assistantTexts", async () => {
      const { onLlmOutput } = await importFresh()

      const ctx = makeCtx()
      vi.advanceTimersByTime(3000)
      // texts has an element but it's null — ?? "" kicks in, text is too short
      await onLlmOutput({ assistantTexts: [null as any], runId: "r1", sessionId: "s1" }, ctx)

      // Empty string is not > 20 chars, so no emit
      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("debounces thoughts and emits after DEBOUNCE_MS", async () => {
      const { onLlmOutput } = await importFresh()

      const longText = "This is a sufficiently long text that exceeds twenty characters"
      const ctx = makeCtx()

      // First call — emits immediately (lastEmitTime starts at 0, Date.now() is large)
      await onLlmOutput({ assistantTexts: [longText], runId: "r1", sessionId: "s1" }, ctx)
      expect(mockEmitActivity).toHaveBeenCalledTimes(1)

      // Second call within debounce window — should NOT emit
      vi.advanceTimersByTime(1000) // only 1s, within 2s debounce
      await onLlmOutput(
        { assistantTexts: ["Different text that is also long enough now"], runId: "r1", sessionId: "s1" },
        ctx,
      )
      expect(mockEmitActivity).toHaveBeenCalledTimes(1) // still 1

      // Advance past debounce (2000ms)
      vi.advanceTimersByTime(2500)

      await onLlmOutput({ assistantTexts: [longText], runId: "r1", sessionId: "s1" }, ctx)
      expect(mockEmitActivity).toHaveBeenCalledTimes(2)
      expect(mockEmitActivity).toHaveBeenLastCalledWith("linear-session-123", {
        type: "thought",
        body: longText.slice(0, 500),
      })
    })

    it("does not emit during tool calls", async () => {
      const { onLlmOutput, onBeforeToolCall } = await importFresh()

      const ctx = makeCtx()

      // Start a tool call — marks isToolCallActive
      onBeforeToolCall({ toolName: "search", input: {} }, ctx)
      await vi.advanceTimersByTimeAsync(3000)

      // LLM output during tool call should be suppressed
      const longText = "This is a sufficiently long text that exceeds twenty characters"
      await onLlmOutput({ assistantTexts: [longText], runId: "r1", sessionId: "s1" }, ctx)

      // The onBeforeToolCall may have emitted, but onLlmOutput should not add a thought
      const thoughtCalls = mockEmitActivity.mock.calls.filter((call: any[]) => call[1]?.body?.includes("sufficiently"))
      expect(thoughtCalls).toHaveLength(0)
    })

    it("does nothing when no Linear API available", async () => {
      mockGetLinearApi.mockReturnValue(null)
      const { onLlmOutput } = await importFresh()

      const ctx = makeCtx()
      vi.advanceTimersByTime(3000)
      await onLlmOutput(
        {
          assistantTexts: ["This is a sufficiently long text that exceeds twenty characters"],
          runId: "r1",
          sessionId: "s1",
        },
        ctx,
      )

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("truncates thought body to THOUGHT_MAX_LENGTH", async () => {
      const { onLlmOutput } = await importFresh()

      const ctx = makeCtx()
      vi.advanceTimersByTime(3000)
      const longText = "a".repeat(600)
      await onLlmOutput({ assistantTexts: [longText], runId: "r1", sessionId: "s1" }, ctx)

      expect(mockEmitActivity).toHaveBeenCalledWith("linear-session-123", {
        type: "thought",
        body: "a".repeat(500),
      })
    })
  })

  describe("onBeforeToolCall", () => {
    it("emits action start activity", async () => {
      const { onBeforeToolCall } = await importFresh()

      onBeforeToolCall({ toolName: "search", input: {} }, makeCtx())
      await vi.advanceTimersByTimeAsync(0)

      expect(mockEmitActivity).toHaveBeenCalledWith("linear-session-123", {
        type: "thought",
        body: expect.stringContaining("search"),
      })
    })

    it("ignores non-linear sessions", async () => {
      const { onBeforeToolCall } = await importFresh()

      onBeforeToolCall({ toolName: "search", input: {} }, { sessionKey: "slack:xxx" })
      await vi.advanceTimersByTimeAsync(0)

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("does nothing when no Linear API", async () => {
      mockGetLinearApi.mockReturnValue(null)
      const { onBeforeToolCall } = await importFresh()

      onBeforeToolCall({ toolName: "search", input: {} }, makeCtx())
      await vi.advanceTimersByTimeAsync(0)

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })
  })

  describe("onAfterToolCall", () => {
    it("emits action complete activity", async () => {
      const { onBeforeToolCall, onAfterToolCall } = await importFresh()

      onBeforeToolCall({ toolName: "search", input: {} }, makeCtx())
      onAfterToolCall({ toolName: "search", output: {} }, makeCtx())
      await vi.advanceTimersByTimeAsync(0)

      // Should have 2 calls: start and done
      expect(mockEmitActivity).toHaveBeenCalledTimes(2)
      const lastCall = mockEmitActivity.mock.calls[1]
      expect(lastCall[0]).toBe("linear-session-123")
      expect(lastCall[1].body).toContain("search")
      expect(lastCall[1].body).toContain("done")
    })

    it("ignores non-linear sessions", async () => {
      const { onAfterToolCall } = await importFresh()

      onAfterToolCall({ toolName: "search", output: {} }, { sessionKey: "slack:xxx" })
      await vi.advanceTimersByTimeAsync(0)

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })
  })

  describe("onAgentEnd", () => {
    it("emits error thought on failure", async () => {
      const { onLlmOutput, onAgentEnd } = await importFresh()

      const ctx = makeCtx()
      await onLlmOutput({ assistantTexts: ["some thinking text here"], runId: "r1", sessionId: "s1" }, ctx)

      mockEmitActivity.mockClear()
      await onAgentEnd({ success: false, error: "Tool timed out", messages: [] }, ctx)

      expect(mockEmitActivity).toHaveBeenCalledWith("linear-session-123", {
        type: "thought",
        body: expect.stringContaining("Error: Tool timed out"),
      })
    })

    it("emits response on successful end with buffer", async () => {
      const { onLlmOutput, onAgentEnd } = await importFresh()

      const ctx = makeCtx()
      await onLlmOutput({ assistantTexts: ["Final response text here"], runId: "r1", sessionId: "s1" }, ctx)

      mockEmitActivity.mockClear()
      await onAgentEnd({ success: true, messages: [] }, ctx)

      expect(mockEmitActivity).toHaveBeenCalledWith("linear-session-123", {
        type: "response",
        body: "Final response text here",
      })
    })

    it("does nothing when no buffer and success", async () => {
      const { onAgentEnd } = await importFresh()

      await onAgentEnd({ success: true, messages: [] }, makeCtx())

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("ignores non-linear sessions", async () => {
      const { onAgentEnd } = await importFresh()

      await onAgentEnd({ success: true, messages: [] }, { sessionKey: "slack:xxx" })

      expect(mockEmitActivity).not.toHaveBeenCalled()
    })

    it("cleans up stream state after delay", async () => {
      const { onLlmOutput, onAgentEnd } = await importFresh()

      const ctx = makeCtx()
      await onLlmOutput({ assistantTexts: ["Final response"], runId: "r1", sessionId: "s1" }, ctx)

      await onAgentEnd({ success: true, messages: [] }, ctx)

      expect(mockEmitActivity).toHaveBeenCalledWith("linear-session-123", {
        type: "response",
        body: "Final response",
      })

      // Advance past cleanup delay (5000ms)
      vi.advanceTimersByTime(5000)

      // State is cleaned — new onAgentEnd creates fresh state but buffer is empty
      mockEmitActivity.mockClear()
      await onAgentEnd({ success: true, messages: [] }, ctx)
      expect(mockEmitActivity).not.toHaveBeenCalled()
    })
  })

  describe("error handling", () => {
    it("emitThought catches and logs errors without throwing", async () => {
      mockEmitActivity.mockRejectedValue(new Error("network error"))
      const { onLlmOutput } = await importFresh()

      const ctx = makeCtx()
      vi.advanceTimersByTime(3000)
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

      await onLlmOutput(
        {
          assistantTexts: ["This is a sufficiently long text that exceeds twenty characters"],
          runId: "r1",
          sessionId: "s1",
        },
        ctx,
      )

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("failed to emit thought"), expect.any(Error))
      consoleSpy.mockRestore()
    })

    it("emitResponse catches and logs errors without throwing", async () => {
      mockEmitActivity.mockRejectedValue(new Error("network error"))
      const { onLlmOutput, onAgentEnd } = await importFresh()

      const ctx = makeCtx()
      await onLlmOutput({ assistantTexts: ["Final response text here"], runId: "r1", sessionId: "s1" }, ctx)

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      await onAgentEnd({ success: true, messages: [] }, ctx)

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("failed to emit response"), expect.any(Error))
      consoleSpy.mockRestore()
    })

    it("emitAction catches and logs errors without throwing", async () => {
      mockEmitActivity.mockRejectedValue(new Error("network error"))
      const { onBeforeToolCall } = await importFresh()

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

      onBeforeToolCall({ toolName: "search", input: {} }, makeCtx())
      await vi.advanceTimersByTimeAsync(0)

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("failed to emit action"), expect.any(Error))
      consoleSpy.mockRestore()
    })
  })
})
