/**
 * Project-based memory persistence store.
 *
 * Creates and manages per-project directories under
 * ~/.openclaw/plugins/linear-light/projects/<slug>/
 *
 * Each project directory contains:
 * - README.md  — project overview with issue inventory
 * - CONTEXT.md — session continuity context for the agent
 *
 * Follows the same atomic write-then-rename pattern as oauth-store.ts.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Logger } from "./linear-api.js"

const PROJECTS_DIR = join(homedir(), ".openclaw", "plugins", "linear-light", "projects")

/**
 * Convert a Linear project name to a URL-safe directory slug.
 * e.g. "EWL" → "ewl", "My Project" → "my-project", "API v2" → "api-v2"
 */
export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Get the directory path for a project slug.
 */
export function getProjectDir(slug: string): string {
  return join(PROJECTS_DIR, slug)
}

/**
 * Ensure the project directory and its base files exist.
 * Idempotent — safe to call multiple times.
 * Returns the directory path.
 */
export function ensureProjectDir(
  projectName: string,
  opts?: { logger?: Logger; projectUrl?: string },
): { dirPath: string; slug: string } {
  const slug = slugifyProjectName(projectName)
  const dirPath = getProjectDir(slug)

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 })
    opts?.logger?.info(`Linear Light: created project directory ${dirPath}`)

    // Initialize README.md
    const readme = buildReadme(projectName, opts?.projectUrl)
    atomicWrite(join(dirPath, "README.md"), readme)

    // Initialize CONTEXT.md
    const context = buildContext(projectName)
    atomicWrite(join(dirPath, "CONTEXT.md"), context)

    opts?.logger?.info(`Linear Light: initialized project files for "${projectName}"`)
  }

  return { dirPath, slug }
}

/**
 * Resolve project info from an issue's project field.
 * Returns null if the issue has no project.
 */
export function resolveProjectInfo(
  project: { id: string; name: string } | null | undefined,
  opts?: { logger?: Logger; projectUrl?: string },
): { dirPath: string; slug: string; id: string; name: string } | null {
  if (!(project?.id && project?.name)) return null

  const { dirPath, slug } = ensureProjectDir(project.name, opts)
  return { id: project.id, name: project.name, slug, dirPath }
}

/**
 * Build the default README.md content for a new project.
 */
function buildReadme(projectName: string, projectUrl?: string): string {
  const lines = [
    `# ${projectName}`,
    "",
    projectUrl ? `Linear: ${projectUrl}` : "",
    "",
    "## Issues",
    "",
    "| Identifier | Title | Status | Priority |",
    "| --- | --- | --- | --- |",
    "",
  ]
  return `${lines.filter(Boolean).join("\n")}\n`
}

/**
 * Build the default CONTEXT.md content for a new project.
 */
function buildContext(projectName: string): string {
  return [
    `# ${projectName} — Session Context`,
    "",
    "This file stores technical context for session continuity.",
    "The agent should update this file as work progresses.",
    "",
    "## Current State",
    "",
    "- Status: Initialized",
    "- Last updated: (none)",
    "",
    "## Notes",
    "",
    "",
  ].join("\n")
}

/**
 * Atomic write-then-rename to prevent corruption.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 })
  renameSync(tmpPath, filePath)
}
