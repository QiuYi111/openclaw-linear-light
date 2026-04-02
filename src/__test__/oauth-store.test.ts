import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// OAuth store unit tests
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

describe("oauth-store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("readStoredToken", () => {
    it("returns null when file does not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { readStoredToken } = await import("../api/oauth-store.js")
      expect(readStoredToken()).toBeNull()
    })

    it("returns null when file has no accessToken", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify({ refreshToken: "only-refresh" }))
      const { readStoredToken } = await import("../api/oauth-store.js")
      expect(readStoredToken()).toBeNull()
    })

    it("returns null when file is invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue("not json")
      const { readStoredToken } = await import("../api/oauth-store.js")
      expect(readStoredToken()).toBeNull()
    })

    it("returns stored token with all fields", async () => {
      mockExistsSync.mockReturnValue(true)
      const tokenData = {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1234567890,
      }
      mockReadFileSync.mockReturnValue(JSON.stringify(tokenData))
      const { readStoredToken } = await import("../api/oauth-store.js")
      const result = readStoredToken()
      expect(result).toEqual(tokenData)
    })
  })

  describe("writeStoredToken", () => {
    it("creates directory if it does not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { writeStoredToken } = await import("../api/oauth-store.js")

      writeStoredToken({ accessToken: "at-new" })

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining("linear-light"), {
        recursive: true,
        mode: 0o700,
      })
    })

    it("writes token atomically (tmp + rename)", async () => {
      mockExistsSync.mockReturnValue(true)
      const { writeStoredToken } = await import("../api/oauth-store.js")

      writeStoredToken({
        accessToken: "at-new",
        refreshToken: "rt-new",
        expiresAt: 999,
      })

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
      const [tmpPath, content, options] = mockWriteFileSync.mock.calls[0] as [
        string,
        string,
        { encoding: string; mode: number },
      ]
      expect(tmpPath).toMatch(/\.tmp$/)
      expect(JSON.parse(content).accessToken).toBe("at-new")
      expect(options.mode).toBe(0o600)
      expect(options.encoding).toBe("utf8")
      expect(mockRenameSync).toHaveBeenCalledWith(tmpPath, expect.stringContaining("token.json"))
    })

    it("handles write errors gracefully", async () => {
      mockExistsSync.mockReturnValue(true)
      mockWriteFileSync.mockImplementation(() => {
        throw new Error("permission denied")
      })

      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

      const { writeStoredToken } = await import("../api/oauth-store.js")

      // Should not throw
      expect(() => writeStoredToken({ accessToken: "at" }, mockLogger)).not.toThrow()
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("failed to write token store"))
    })
  })
})
