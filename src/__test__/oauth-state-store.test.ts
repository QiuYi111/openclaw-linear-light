import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// OAuth state store unit tests
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockRenameSync = vi.fn()

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}))

describe("oauth-state-store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("readPendingStates", () => {
    it("returns null when file does not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { readPendingStates } = await import("../api/oauth-state-store.js")
      expect(readPendingStates()).toBeNull()
    })

    it("returns null when file is invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue("not json")
      const { readPendingStates } = await import("../api/oauth-state-store.js")
      expect(readPendingStates()).toBeNull()
    })

    it("returns states and filters out expired entries", async () => {
      mockExistsSync.mockReturnValue(true)
      const states = {
        "valid-state": {
          codeVerifier: "cv1",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() + 600_000,
        },
        "expired-state": {
          codeVerifier: "cv2",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() - 1000,
        },
      }
      mockReadFileSync.mockReturnValue(JSON.stringify(states))
      const { readPendingStates } = await import("../api/oauth-state-store.js")
      const result = readPendingStates()
      expect(result).not.toBeNull()
      expect(result).toHaveProperty("valid-state")
      expect(result).not.toHaveProperty("expired-state")
    })

    it("returns empty object when all states are expired", async () => {
      mockExistsSync.mockReturnValue(true)
      const states = {
        "expired-1": {
          codeVerifier: "cv1",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() - 1000,
        },
        "expired-2": {
          codeVerifier: "cv2",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() - 2000,
        },
      }
      mockReadFileSync.mockReturnValue(JSON.stringify(states))
      const { readPendingStates } = await import("../api/oauth-state-store.js")
      const result = readPendingStates()
      expect(result).not.toBeNull()
      expect(Object.keys(result as Record<string, unknown>)).toHaveLength(0)
    })

    it("persists cleanup when expired entries are removed", async () => {
      mockExistsSync.mockReturnValue(true)
      const states = {
        valid: {
          codeVerifier: "cv",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() + 600_000,
        },
        expired: {
          codeVerifier: "cv2",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() - 1000,
        },
      }
      mockReadFileSync.mockReturnValue(JSON.stringify(states))
      const { readPendingStates } = await import("../api/oauth-state-store.js")
      readPendingStates()
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    })
  })

  describe("getPendingState", () => {
    it("returns null when file does not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { getPendingState } = await import("../api/oauth-state-store.js")
      expect(getPendingState("some-state")).toBeNull()
    })

    it("returns null for non-existent state key", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "other-state": {
            codeVerifier: "cv",
            redirectUri: "https://example.com/callback",
            expiresAt: Date.now() + 600_000,
          },
        }),
      )
      const { getPendingState } = await import("../api/oauth-state-store.js")
      expect(getPendingState("missing-state")).toBeNull()
    })

    it("returns the state data for a valid key", async () => {
      mockExistsSync.mockReturnValue(true)
      const data = {
        codeVerifier: "cv-123",
        redirectUri: "https://example.com/callback",
        expiresAt: Date.now() + 600_000,
      }
      mockReadFileSync.mockReturnValue(JSON.stringify({ "my-state": data }))
      const { getPendingState } = await import("../api/oauth-state-store.js")
      expect(getPendingState("my-state")).toEqual(data)
    })

    it("returns null for expired state", async () => {
      mockExistsSync.mockReturnValue(true)
      const data = {
        codeVerifier: "cv-expired",
        redirectUri: "https://example.com/callback",
        expiresAt: Date.now() - 1000,
      }
      mockReadFileSync.mockReturnValue(JSON.stringify({ "expired-state": data }))
      const { getPendingState } = await import("../api/oauth-state-store.js")
      expect(getPendingState("expired-state")).toBeNull()
    })
  })

  describe("savePendingState", () => {
    it("creates directory if it does not exist and writes atomically", async () => {
      mockExistsSync.mockReturnValue(false)
      const { savePendingState } = await import("../api/oauth-state-store.js")

      savePendingState("s1", {
        codeVerifier: "cv1",
        redirectUri: "https://example.com/callback",
        expiresAt: Date.now() + 600_000,
      })

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining("linear-light"), {
        recursive: true,
        mode: 0o700,
      })
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
      expect(mockRenameSync).toHaveBeenCalledTimes(1)
    })

    it("appends to existing states on disk", async () => {
      mockExistsSync.mockReturnValue(true)
      const existing = {
        "old-state": {
          codeVerifier: "old-cv",
          redirectUri: "https://example.com/callback",
          expiresAt: Date.now() + 600_000,
        },
      }
      mockReadFileSync.mockReturnValue(JSON.stringify(existing))
      const { savePendingState } = await import("../api/oauth-state-store.js")

      savePendingState("new-state", {
        codeVerifier: "new-cv",
        redirectUri: "https://example.com/callback",
        expiresAt: Date.now() + 600_000,
      })

      const [tmpPath, content] = mockWriteFileSync.mock.calls[0] as [string, string]
      expect(tmpPath).toMatch(/\.tmp$/)
      const written = JSON.parse(content)
      expect(written).toHaveProperty("old-state")
      expect(written).toHaveProperty("new-state")
    })
  })

  describe("deletePendingState", () => {
    it("does nothing when file does not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { deletePendingState } = await import("../api/oauth-state-store.js")
      expect(() => deletePendingState("nonexistent")).not.toThrow()
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it("does nothing when state key does not exist", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "other-key": {
            codeVerifier: "cv",
            redirectUri: "https://example.com/callback",
            expiresAt: Date.now() + 600_000,
          },
        }),
      )
      const { deletePendingState } = await import("../api/oauth-state-store.js")
      deletePendingState("missing-key")
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it("removes the state and persists the change", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "keep-me": {
            codeVerifier: "cv1",
            redirectUri: "https://example.com/callback",
            expiresAt: Date.now() + 600_000,
          },
          "delete-me": {
            codeVerifier: "cv2",
            redirectUri: "https://example.com/callback",
            expiresAt: Date.now() + 600_000,
          },
        }),
      )
      const { deletePendingState } = await import("../api/oauth-state-store.js")

      deletePendingState("delete-me")

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
      const [, content] = mockWriteFileSync.mock.calls[0] as [string, string]
      const written = JSON.parse(content)
      expect(written).toHaveProperty("keep-me")
      expect(written).not.toHaveProperty("delete-me")
    })
  })
})
