/**
 * Project-based memory persistence store.
 *
 * Creates and manages per-project directories under the configured base path
 * (default: ~/clawd/projects/<slug>/).
 *
 * Each project directory contains:
 * - AGENTS.md   — project rules and instructions (agent must read first)
 * - README.md   — project purpose and background
 * - Context.md  — refined/extracted context for session continuity (written by agent)
 * - issues/     — per-issue conversation records (auto-managed by plugin)
 *
 * Follows the same atomic write-then-rename pattern as oauth-store.ts.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { Logger } from "./linear-api.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProjectStoreConfig {
  enabled: boolean
  basePath: string // e.g., "/Users/jingyi/clawd/projects"
  autoGit: boolean // auto git init / commit / push on dir creation
}

let _config: ProjectStoreConfig = {
  enabled: true,
  basePath: resolve(homedir(), "clawd", "projects"),
  autoGit: true,
}

export function setProjectStoreConfig(pluginConfig: Record<string, unknown> | undefined): void {
  const cfg = pluginConfig ?? {}
  _config = {
    enabled: cfg.projectMemoryEnabled !== false,
    basePath: (cfg.projectMemoryBasePath as string) || resolve(homedir(), "clawd", "projects"),
    autoGit: cfg.projectMemoryAutoGit !== false,
  }
}

export function getProjectStoreConfig(): ProjectStoreConfig {
  return _config
}

/**
 * Convert a Linear project name and id to a unique, URL-safe directory slug.
 * Includes a short hash of the project id to prevent collisions between
 * projects whose names slugify to the same string (e.g. "A/B" and "AB").
 * e.g. ("My Project", "abc123") → "my-project-a1b2c3"
 */
export function slugifyProjectName(name: string, projectId?: string): string {
  const nameSlug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (!nameSlug) return projectId ? `proj-${shortHash(projectId)}` : ""

  if (!projectId) return nameSlug

  return `${nameSlug}-${shortHash(projectId)}`
}

/** Short deterministic hash from a string (first 6 hex chars of simple hash). */
function shortHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(16).padStart(6, "0").slice(0, 6)
}

/**
 * Get the directory path for a project slug.
 */
export function getProjectDir(slug: string, basePath?: string): string {
  return join(basePath ?? _config.basePath, slug)
}

/**
 * Ensure the project directory and its base files exist.
 * Idempotent — safe to call multiple times.
 * Returns the directory path.
 */
export function ensureProjectDir(
  projectName: string,
  opts?: { logger?: Logger; projectUrl?: string; projectId?: string },
): { dirPath: string; slug: string; created: boolean } {
  const slug = slugifyProjectName(projectName, opts?.projectId)
  const dirPath = getProjectDir(slug)

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 })
    opts?.logger?.info(`Linear Light: created project directory ${dirPath}`)

    // Initialize AGENTS.md (project rules — agent must read first)
    atomicWrite(join(dirPath, "AGENTS.md"), buildAgentsMd(projectName))

    // Initialize README.md (project purpose and background)
    atomicWrite(join(dirPath, "README.md"), buildReadme(projectName, opts?.projectUrl))

    // Initialize Context.md (refined/extracted context — written by agent)
    atomicWrite(join(dirPath, "Context.md"), buildContext(projectName))

    // Create issues/ directory (auto-managed by plugin)
    mkdirSync(join(dirPath, "issues"), { mode: 0o700 })

    opts?.logger?.info(`Linear Light: initialized project files for "${projectName}"`)

    // Auto-init git repo if configured
    if (_config.autoGit) {
      initGitRepo(dirPath, opts?.logger)
    }

    return { dirPath, slug, created: true }
  }

  return { dirPath, slug, created: false }
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

  const { dirPath, slug } = ensureProjectDir(project.name, { ...opts, projectId: project.id })
  return { id: project.id, name: project.name, slug, dirPath }
}

/** Shape of a single comment from Linear API. */
interface IssueComment {
  user: { name: string | null } | null
  body: string
  createdAt: string
}

/**
 * Sync an issue's conversation to the project's issues/ directory.
 * Pulls comments from Linear API and writes them to `issues/<identifier>.md`.
 * Called automatically by the plugin — the agent should NOT write to issues/ manually.
 */
export function syncIssueConversation(
  projectDirPath: string,
  issueIdentifier: string,
  comments: IssueComment[],
  opts?: { logger?: Logger },
): void {
  const issuesDir = join(projectDirPath, "issues")
  if (!existsSync(issuesDir)) {
    mkdirSync(issuesDir, { recursive: true, mode: 0o700 })
  }

  const lines = [`# ${issueIdentifier} — Conversation`, ""]

  for (const comment of comments) {
    const author = comment.user?.name ?? "Unknown"
    const time = comment.createdAt ? new Date(comment.createdAt).toISOString().replace("T", " ").split(".")[0] : ""
    lines.push(`## ${author}${time ? ` (${time})` : ""}`, "", comment.body, "")
  }

  if (comments.length === 0) {
    lines.push("_No comments yet._", "")
  }

  atomicWrite(join(issuesDir, `${issueIdentifier}.md`), lines.join("\n"))
  opts?.logger?.info(`Linear Light: synced ${comments.length} comments for ${issueIdentifier}`)
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
    "- `Context.md` — Refined/extracted context: technical state, key findings, architecture decisions. **You should update this file** as work progresses.",
    "- `issues/` — Per-issue conversation records, auto-managed by the plugin. **Do not write to this directory manually.**",
    "- `AGENTS.md` — This file. Contains project rules and user instructions.",
    "",
    "## Instructions",
    "",
    "- Always read `Context.md` before starting work to understand current state.",
    "- Update `Context.md` when making significant progress or discoveries.",
    "- Do not modify files in `issues/` — the plugin syncs them automatically from Linear.",
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
 * Initialize a git repo in the project directory if it doesn't exist.
 */
export function initGitRepo(dirPath: string, logger?: Logger): boolean {
  const gitDir = join(dirPath, ".git")
  if (existsSync(gitDir)) return false

  try {
    execSync("git init", { cwd: dirPath, stdio: "pipe" })
    // Create initial commit
    execSync("git add -A && git commit -m 'init: project directory'", {
      cwd: dirPath,
      stdio: "pipe",
      timeout: 30_000,
    })
    logger?.info(`Linear Light: initialized git repo in ${dirPath}`)
    return true
  } catch (err) {
    logger?.warn(`Linear Light: git init failed for ${dirPath}: ${err}`)
    return false
  }
}

/**
 * Save/append content to a file in the project directory and optionally git commit + push.
 * Used by the project_memory_save tool.
 */
export function saveProjectFile(
  dirPath: string,
  filename: string,
  content: string,
  mode: "replace" | "append" = "replace",
  logger?: Logger,
): { ok: boolean; message: string } {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }

    const filePath = join(dirPath, filename)
    if (mode === "append" && existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf-8")
      writeFileSync(filePath, `${existing}\n${content}`, "utf-8")
    } else {
      writeFileSync(filePath, content, "utf-8")
    }

    // Git commit + push if configured
    let gitMsg = ""
    if (_config.autoGit) {
      try {
        if (!existsSync(join(dirPath, ".git"))) {
          initGitRepo(dirPath, logger)
        }
        const commitMsg = `update ${filename}`
        execSync(`git add -A && git commit -m ${JSON.stringify(commitMsg)} && git push`, {
          cwd: dirPath,
          stdio: "pipe",
          timeout: 30_000,
        })
        gitMsg = " (committed + pushed)"
      } catch (err) {
        gitMsg = ` (git failed: ${err instanceof Error ? err.message : String(err)})`
        logger?.warn(`Linear Light: git commit failed: ${err}`)
      }
    }

    return { ok: true, message: `Saved ${filename} to ${dirPath}${gitMsg}` }
  } catch (err) {
    return { ok: false, message: `Failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Atomic write-then-rename to prevent corruption.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 })
  renameSync(tmpPath, filePath)
}
