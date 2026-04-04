/**
 * Completion Loop (Ralph Loop) for Linear agent sessions
 *
 * If an agent session ends without the issue reaching a terminal state,
 * this module periodically prompts the agent to continue working.
 *
 * Stops when:
 * - Issue reaches a terminal state (Done, Canceled)
 * - Explicit cancel via stopCompletionLoop()
 * - Max iterations reached (if configured)
 *
 * Loop state is persisted to disk so active loops survive gateway restarts.
 */

import type { Logger } from "./api/linear-api.js"
import { getLinearApi } from "./runtime.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionLoopConfig {
  enabled: boolean
  intervalMs: number
  maxIterations: number // 0 = unlimited
  promptMessage: string
}

interface LoopState {
  timer: ReturnType<typeof setTimeout>
  iterations: number
  issueId: string
  sessionKey: string
  issueIdentifier: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeLoops = new Map<string, LoopState>()

const TERMINAL_STATE_NAMES = ["done", "canceled"]

function isTerminalState(stateName: string): boolean {
  return TERMINAL_STATE_NAMES.includes(stateName.toLowerCase())
}

// ---------------------------------------------------------------------------
// Prompt dispatch
// ---------------------------------------------------------------------------

let dispatchToAgentFn: ((issueId: string, issueIdentifier: string, body: string) => Promise<void>) | null = null

/**
 * Inject the dispatch function (set during plugin registration).
 * Avoids circular dependency between webhook-handler and completion-loop.
 */
export function setCompletionLoopDispatcher(
  fn: (issueId: string, issueIdentifier: string, body: string) => Promise<void>,
): void {
  dispatchToAgentFn = fn
}

// ---------------------------------------------------------------------------
// Logger injection
// ---------------------------------------------------------------------------

let _logger: Logger = console as unknown as Logger

export function setCompletionLoopLogger(logger: Logger): void {
  _logger = logger
}

// ---------------------------------------------------------------------------
// Core loop logic
// ---------------------------------------------------------------------------

async function tick(state: LoopState): Promise<void> {
  let shouldContinue = true

  const api = getLinearApi()
  if (!api) {
    _logger.error("[Linear Light] completion loop: no Linear API available, stopping")
    activeLoops.delete(state.issueId)
    removePersistedLoop(state.issueId)
    return
  }

  try {
    const issue = await api.getIssueDetails(state.issueId)
    const currentState = issue.state?.name

    if (currentState && isTerminalState(currentState)) {
      _logger.info(`[Linear Light] completion loop: ${state.issueIdentifier} is "${currentState}", stopping loop`)
      activeLoops.delete(state.issueId)
      removePersistedLoop(state.issueId)
      return
    }

    // Check max iterations before dispatching
    const config = getConfig()
    if (config.maxIterations > 0 && state.iterations >= config.maxIterations) {
      _logger.info(
        `[Linear Light] completion loop: ${state.issueIdentifier} reached max iterations (${config.maxIterations}), stopping`,
      )
      activeLoops.delete(state.issueId)
      removePersistedLoop(state.issueId)
      return
    }

    // Dispatch follow-up prompt
    state.iterations++
    _logger.info(
      `[Linear Light] completion loop: prompting agent for ${state.issueIdentifier} (iteration ${state.iterations})`,
    )

    if (dispatchToAgentFn) {
      const prompt = config.promptMessage
        .replace("{identifier}", state.issueIdentifier)
        .replace("{state}", currentState || "unknown")
        .replace("{iteration}", String(state.iterations))

      await dispatchToAgentFn(state.issueId, state.issueIdentifier, prompt)
    }

    // If this iteration just hit the max, don't re-schedule
    if (config.maxIterations > 0 && state.iterations >= config.maxIterations) {
      shouldContinue = false
      _logger.info(
        `[Linear Light] completion loop: ${state.issueIdentifier} reached max iterations (${config.maxIterations}), stopping`,
      )
      activeLoops.delete(state.issueId)
      removePersistedLoop(state.issueId)
    }
  } catch (err) {
    _logger.error(`[Linear Light] completion loop tick error for ${state.issueIdentifier}: ${err}`)
    // Don't stop the loop on error — retry next interval
  }

  // Schedule next tick only if still active and should continue
  if (shouldContinue && activeLoops.has(state.issueId)) {
    const loop = activeLoops.get(state.issueId)
    if (loop) {
      loop.timer = setTimeout(() => tick(loop), getConfig().intervalMs)
    }
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

let _pluginConfig: Record<string, unknown> | undefined

export function setCompletionLoopConfig(config: Record<string, unknown> | undefined): void {
  _pluginConfig = config
}

export function getConfig(): CompletionLoopConfig {
  const cfg = _pluginConfig ?? {}
  const intervalMinutes = (cfg.completionLoopInterval as number) ?? 10
  return {
    enabled: cfg.completionLoopEnabled !== false, // default true
    intervalMs: Math.max(60_000, intervalMinutes * 60_000), // minimum 1 minute
    maxIterations: (cfg.completionLoopMaxIterations as number) ?? 0,
    promptMessage:
      (cfg.completionLoopPrompt as string) ||
      '[Completion Check] The issue {identifier} is still in "{state}" state. Please continue working on it. If you believe the work is complete, use the linear_update_status tool to mark it as Done.',
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a completion loop for an issue.
 * If a loop is already active for this issue, it is stopped and restarted.
 */
export function startCompletionLoop(params: { issueId: string; issueIdentifier: string; sessionKey: string }): void {
  const { issueId, issueIdentifier, sessionKey } = params

  // Stop existing loop if any
  stopCompletionLoop(issueId)

  const config = getConfig()
  if (!config.enabled) return

  const state: LoopState = {
    timer: setTimeout(() => tick(state), config.intervalMs),
    iterations: 0,
    issueId,
    sessionKey,
    issueIdentifier,
  }
  activeLoops.set(issueId, state)
  persistLoops()

  _logger.info(`[Linear Light] completion loop started for ${issueIdentifier} (interval: ${config.intervalMs / 1000}s)`)
}

/**
 * Stop the completion loop for a specific issue.
 */
export function stopCompletionLoop(issueId: string): void {
  const loop = activeLoops.get(issueId)
  if (loop) {
    clearTimeout(loop.timer)
    activeLoops.delete(issueId)
    _logger.info(`[Linear Light] completion loop stopped for ${loop.issueIdentifier}`)
  }
}

/**
 * Check if a completion loop is active for an issue.
 */
export function isCompletionLoopActive(issueId: string): boolean {
  return activeLoops.has(issueId)
}

/**
 * Get the number of active loops (for diagnostics).
 */
export function getActiveLoopCount(): number {
  return activeLoops.size
}

/**
 * Stop all active completion loops.
 */
export function stopAllCompletionLoops(): void {
  for (const [issueId] of activeLoops) {
    stopCompletionLoop(issueId)
  }
}

/**
 * Resume persisted loops from disk.
 *
 * Called at plugin startup. For each persisted loop:
 * 1. Check if the issue is already in a terminal state → skip
 * 2. Check if the feature is still enabled → skip
 * 3. Check if max iterations is exceeded → skip
 * 4. Otherwise, start the loop with the persisted iteration count
 *
 * After processing, the persisted file is rewritten with only the resumed loops.
 */
export async function resumePersistedLoops(): Promise<number> {
  const persisted = readPersistedLoops()
  const entries = Object.entries(persisted)
  if (entries.length === 0) return 0

  const config = getConfig()
  if (!config.enabled) {
    console.info("[Linear Light] completion loop: persistence found but feature is disabled, clearing")
    writePersistedLoops({})
    return 0
  }

  const api = getLinearApi()
  if (!api) {
    console.warn("[Linear Light] completion loop: persistence found but no Linear API available, skipping resume")
    return 0
  }

  let resumed = 0
  const stillActive: Record<string, (typeof persisted)[string]> = {}

  for (const [issueId, loop] of entries) {
    try {
      // Check if issue has reached terminal state during downtime
      const issue = await api.getIssueDetails(issueId)
      if (issue.state?.name && isTerminalState(issue.state.name)) {
        console.info(
          `[Linear Light] completion loop: skipping resume for ${loop.issueIdentifier} — already "${issue.state.name}"`,
        )
        continue
      }

      // Check if max iterations exceeded
      if (config.maxIterations > 0 && loop.iterations >= config.maxIterations) {
        console.info(
          `[Linear Light] completion loop: skipping resume for ${loop.issueIdentifier} — already at max iterations`,
        )
        continue
      }

      // Resume the loop
      const state: LoopState = {
        timer: setTimeout(() => tick(state), config.intervalMs),
        iterations: loop.iterations,
        issueId: loop.issueId,
        sessionKey: loop.sessionKey,
        issueIdentifier: loop.issueIdentifier,
      }
      activeLoops.set(issueId, state)
      stillActive[issueId] = loop
      resumed++
      console.info(`[Linear Light] completion loop: resumed for ${loop.issueIdentifier} (iteration ${loop.iterations})`)
    } catch (err) {
      console.error(`[Linear Light] completion loop: failed to resume for ${loop.issueIdentifier}:`, err)
    }
  }

  // Rewrite the persisted file with only the loops we actually resumed
  writePersistedLoops(stillActive)

  return resumed
}
