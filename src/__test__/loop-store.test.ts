import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Loop store tests — uses a real temp directory for file I/O
// ---------------------------------------------------------------------------

const MOCK_DIR = join(tmpdir(), `openclaw-loop-store-test-${Date.now()}`)

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => MOCK_DIR }
})

async function importFresh() {
  vi.resetModules()
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>()
    return { ...actual, homedir: () => MOCK_DIR }
  })
  return await import("../api/loop-store.js")
}

describe("loop-store", () => {
  beforeEach(() => {
    mkdirSync(MOCK_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(MOCK_DIR, { recursive: true, force: true })
  })

  describe("readPersistedLoops", () => {
    it("returns empty object when file does not exist", async () => {
      const { readPersistedLoops } = await importFresh()
      expect(readPersistedLoops()).toEqual({})
    })

    it("returns parsed data from valid file", async () => {
      const { readPersistedLoops } = await importFresh()
      const { writeFileSync, mkdirSync } = await import("node:fs")
      const { join } = await import("node:path")
      const dir = join(MOCK_DIR, ".openclaw", "plugins", "linear-light")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "completion-loops.json"),
        JSON.stringify({
          "issue-1": {
            issueId: "issue-1",
            issueIdentifier: "ENG-42",
            sessionKey: "key",
            iterations: 3,
            startedAt: 123,
          },
        }),
      )

      const result = readPersistedLoops()
      expect(result).toEqual({
        "issue-1": { issueId: "issue-1", issueIdentifier: "ENG-42", sessionKey: "key", iterations: 3, startedAt: 123 },
      })
    })

    it("returns empty object for corrupt JSON", async () => {
      const { readPersistedLoops } = await importFresh()
      const { writeFileSync, mkdirSync } = await import("node:fs")
      const { join } = await import("node:path")
      const dir = join(MOCK_DIR, ".openclaw", "plugins", "linear-light")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "completion-loops.json"), "not json{{{")

      expect(readPersistedLoops()).toEqual({})
    })

    it("returns empty object for non-object JSON", async () => {
      const { readPersistedLoops } = await importFresh()
      const { writeFileSync, mkdirSync } = await import("node:fs")
      const { join } = await import("node:path")
      const dir = join(MOCK_DIR, ".openclaw", "plugins", "linear-light")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "completion-loops.json"), '"a string"')

      expect(readPersistedLoops()).toEqual({})
    })
  })

  describe("writePersistedLoops", () => {
    it("creates directory and writes file", async () => {
      const { writePersistedLoops, readPersistedLoops } = await importFresh()

      const loops = {
        "issue-1": { issueId: "issue-1", issueIdentifier: "ENG-42", sessionKey: "key", iterations: 1, startedAt: 100 },
      }
      writePersistedLoops(loops)

      expect(readPersistedLoops()).toEqual(loops)
    })

    it("overwrites existing file", async () => {
      const { writePersistedLoops, readPersistedLoops } = await importFresh()

      writePersistedLoops({
        "issue-1": { issueId: "issue-1", issueIdentifier: "ENG-42", sessionKey: "key", iterations: 1, startedAt: 100 },
      })
      writePersistedLoops({})

      expect(readPersistedLoops()).toEqual({})
    })

    it("writes empty object to clear all loops", async () => {
      const { writePersistedLoops, readPersistedLoops } = await importFresh()

      writePersistedLoops({
        "issue-1": { issueId: "issue-1", issueIdentifier: "ENG-42", sessionKey: "key", iterations: 5, startedAt: 100 },
      })
      writePersistedLoops({})

      expect(readPersistedLoops()).toEqual({})
    })
  })
})
