import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Project store unit tests
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockRenameSync = vi.fn()

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}))

describe("project-store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("slugifyProjectName", () => {
    it("lowercases and replaces spaces with hyphens", async () => {
      const { slugifyProjectName } = await import("../api/project-store.js")
      expect(slugifyProjectName("My Project")).toBe("my-project")
    })

    it("handles already-lowercase names", async () => {
      const { slugifyProjectName } = await import("../api/project-store.js")
      expect(slugifyProjectName("ewl")).toBe("ewl")
    })

    it("collapses multiple special characters into single hyphen", async () => {
      const { slugifyProjectName } = await import("../api/project-store.js")
      expect(slugifyProjectName("API v2 -- Beta!!")).toBe("api-v2-beta")
    })

    it("trims leading and trailing hyphens", async () => {
      const { slugifyProjectName } = await import("../api/project-store.js")
      expect(slugifyProjectName("  -- hello -- ")).toBe("hello")
    })

    it("handles names with only special characters", async () => {
      const { slugifyProjectName } = await import("../api/project-store.js")
      expect(slugifyProjectName("!!! ???")).toBe("")
    })
  })

  describe("getProjectDir", () => {
    it("returns path under projects directory", async () => {
      const { getProjectDir } = await import("../api/project-store.js")
      const dir = getProjectDir("my-project")
      expect(dir).toMatch(/projects\/my-project$/)
    })
  })

  describe("ensureProjectDir", () => {
    it("creates directory and files when they do not exist", async () => {
      mockExistsSync.mockReturnValue(false)
      const { ensureProjectDir } = await import("../api/project-store.js")

      const result = ensureProjectDir("Test Project")

      expect(result.slug).toBe("test-project")
      expect(result.dirPath).toMatch(/projects\/test-project$/)
      expect(mockMkdirSync).toHaveBeenCalledWith(result.dirPath, {
        recursive: true,
        mode: 0o700,
      })
      // Should create README.md and CONTEXT.md (2 writes + 2 renames)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2)
      expect(mockRenameSync).toHaveBeenCalledTimes(2)
    })

    it("skips creation when directory already exists", async () => {
      mockExistsSync.mockReturnValue(true)
      const { ensureProjectDir } = await import("../api/project-store.js")

      const result = ensureProjectDir("Existing Project")

      expect(result.slug).toBe("existing-project")
      expect(mockMkdirSync).not.toHaveBeenCalled()
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it("includes project URL in README when provided", async () => {
      mockExistsSync.mockReturnValue(false)
      const { ensureProjectDir } = await import("../api/project-store.js")

      ensureProjectDir("My Proj", {
        projectUrl: "https://linear.app/test/project/my-proj",
      })

      const readmeCall = mockWriteFileSync.mock.calls.find(([path]) => (path as string).endsWith("README.md.tmp"))
      expect(readmeCall).toBeDefined()
      expect(readmeCall?.[1]).toContain("https://linear.app/test/project/my-proj")
    })

    it("omits project URL in README when not provided", async () => {
      mockExistsSync.mockReturnValue(false)
      const { ensureProjectDir } = await import("../api/project-store.js")

      ensureProjectDir("My Proj")

      const readmeCall = mockWriteFileSync.mock.calls.find(([path]) => (path as string).endsWith("README.md.tmp"))
      expect(readmeCall).toBeDefined()
      expect(readmeCall?.[1]).not.toContain("Linear:")
    })

    it("logs creation when logger is provided", async () => {
      mockExistsSync.mockReturnValue(false)
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const { ensureProjectDir } = await import("../api/project-store.js")

      ensureProjectDir("Logged Project", { logger })

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("created project directory"))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("initialized project files"))
    })

    it("writes files atomically (tmp + rename)", async () => {
      mockExistsSync.mockReturnValue(false)
      const { ensureProjectDir } = await import("../api/project-store.js")

      ensureProjectDir("Atomic Test")

      for (const [tmpPath, , opts] of mockWriteFileSync.mock.calls) {
        expect(tmpPath).toMatch(/\.tmp$/)
        expect((opts as { mode: number }).mode).toBe(0o600)
      }
      // Each write should be followed by a rename
      expect(mockRenameSync).toHaveBeenCalledTimes(2)
    })
  })

  describe("resolveProjectInfo", () => {
    it("returns null when project is null", async () => {
      mockExistsSync.mockReturnValue(true)
      const { resolveProjectInfo } = await import("../api/project-store.js")

      expect(resolveProjectInfo(null)).toBeNull()
    })

    it("returns null when project is undefined", async () => {
      mockExistsSync.mockReturnValue(true)
      const { resolveProjectInfo } = await import("../api/project-store.js")

      expect(resolveProjectInfo(undefined)).toBeNull()
    })

    it("returns null when project has no id", async () => {
      mockExistsSync.mockReturnValue(true)
      const { resolveProjectInfo } = await import("../api/project-store.js")

      expect(resolveProjectInfo({ id: "", name: "Test" })).toBeNull()
    })

    it("returns null when project has no name", async () => {
      mockExistsSync.mockReturnValue(true)
      const { resolveProjectInfo } = await import("../api/project-store.js")

      expect(resolveProjectInfo({ id: "proj-1", name: "" })).toBeNull()
    })

    it("returns project info with all fields when project is valid", async () => {
      mockExistsSync.mockReturnValue(true)
      const { resolveProjectInfo } = await import("../api/project-store.js")

      const result = resolveProjectInfo({ id: "proj-1", name: "My Project" })

      expect(result).toEqual({
        id: "proj-1",
        name: "My Project",
        slug: "my-project",
        dirPath: expect.stringMatching(/projects\/my-project$/),
      })
    })
  })
})
