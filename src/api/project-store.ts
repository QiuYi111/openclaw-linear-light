/**
 * Project-based memory persistence store.
 *
 * Creates and manages per-project directories under
 * ~/.openclaw/plugins/linear-light/projects/<slug>/
 *
 * Each project directory contains:
 * - AGENTS.md   — project rules and instructions (agent must read first)
 * - README.md   — project purpose and background
 * - Context.md  — refined/extracted context for session continuity
 * - issues/     — per-issue conversation records
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

    // Initialize AGENTS.md (project rules — agent must read first)
    atomicWrite(join(dirPath, "AGENTS.md"), buildAgentsMd(projectName))

    // Initialize README.md (project purpose and background)
    atomicWrite(join(dirPath, "README.md"), buildReadme(projectName, opts?.projectUrl))

    // Initialize Context.md (refined/extracted context)
    atomicWrite(join(dirPath, "Context.md"), buildContext(projectName))

    // Create issues/ directory
    mkdirSync(join(dirPath, "issues"), { mode: 0o700 })

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
 * Build AGENTS.md — the project rules and instructions file.
 * The agent must read this file first; it defines the conventions for all other files.
 */
function buildAgentsMd(projectName: string): string {
  return [
    `# ${projectName} — Agent Rules`,
    "",
    "Read this file first. It defines the rules for working with this project.",
    "",
    "## Project Directory Structure",
    "",
    "- `README.md` — Project purpose and background.",
    "- `Context.md` — Refined/extracted context: technical state, key findings, architecture decisions. Update this as work progresses.",
    "- `issues/` — Per-issue conversation records. Each issue gets `issues/<Identifier>.md`. Pull content from Linear API (comments), do not write manually.",
    "- `AGENTS.md` — This file. Contains project rules and user instructions.",
    "",
    "## Instructions",
    "",
    "- Always read `Context.md` before starting work to understand current state.",
    "- Update `Context.md` when making significant progress or discoveries.",
    "- For issue conversation history, use the Linear API to pull comments into `issues/<Identifier>.md`.",
    "",
  ].join("\n")
}

/**
 * Build README.md — project purpose and background.
 */
function buildReadme(projectName: string, projectUrl?: string): string {
  const lines = [
    `# ${projectName}`,
    "",
    projectUrl ? `Linear: ${projectUrl}` : "",
    "",
    "## Purpose",
    "",
    "",
    "## Background",
    "",
    "",
  ]
  return `${lines.filter(Boolean).join("\n")}\n`
}

/**
 * Build Context.md — refined/extracted context for session continuity.
 */
function buildContext(projectName: string): string {
  return [
    `# ${projectName} — Context`,
    "",
    "Refined/extracted context for session continuity.",
    "Update this file as work progresses.",
    "",
    "## Current State",
    "",
    "- Status: Initialized",
    "- Last updated: (none)",
    "",
    "## Key Findings",
    "",
    "",
    "## Architecture Decisions",
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
