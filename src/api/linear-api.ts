/**
 * Linear API wrapper for OpenClaw Linear Light plugin
 *
 * Lightweight GraphQL client for Linear API.
 * Borrowed from openclaw-linear-plugin (calltelemetry/openclaw-linear-plugin).
 */

import { readStoredToken, writeStoredToken } from "./oauth-store.js"

/**
 * Minimal logger interface matching OpenClaw's api.logger shape.
 */
export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug?(msg: string): void
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token"
const REFRESH_BUFFER_MS = 60_000 // refresh 60s before expiry
const REFRESH_COOLDOWN_MS = 5_000 // coalesce late-arriving 401s for 5s
const TEAM_STATES_TTL_MS = 5 * 60_000 // cache team states for 5 minutes

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter?: string; result?: string }
  | { type: "response"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "error"; body: string }

/**
 * Resolve Linear access token from multiple sources.
 * Can read from Cyrus's config.json to reuse existing OAuth tokens.
 */
export function resolveLinearToken(pluginConfig?: Record<string, unknown>): {
  accessToken: string | null
  refreshToken?: string
  expiresAt?: number
  source: "config" | "none"
} {
  // 1. Plugin-local OAuth token (from ~/.openclaw/plugins/linear-light/token.json)
  try {
    const stored = readStoredToken()
    if (stored?.accessToken) {
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        source: "config" as const,
      }
    }
  } catch {
    // Plugin token file not available
  }

  // 2. Plugin config accessToken
  const fromConfig = pluginConfig?.accessToken
  if (typeof fromConfig === "string" && fromConfig) {
    return { accessToken: fromConfig, source: "config" }
  }

  return { accessToken: null, source: "none" }
}

/**
 * Linear API client
 */
export class LinearAgentApi {
  private accessToken: string
  private refreshToken?: string
  private expiresAt?: number
  private clientId?: string
  private clientSecret?: string
  private logger: Logger
  private refreshPromise: Promise<void> | null = null
  private refreshSuccessTime: number = 0
  /** Cache: teamId → { states[], fetchedAt } */
  private teamStatesCache = new Map<string, { nodes: Array<{ id: string; name: string }>; fetchedAt: number }>()

  constructor(
    accessToken: string,
    opts?: {
      refreshToken?: string
      expiresAt?: number
      clientId?: string
      clientSecret?: string
      source?: string
      logger?: Logger
    },
  ) {
    this.accessToken = accessToken
    this.refreshToken = opts?.refreshToken
    this.expiresAt = opts?.expiresAt
    this.clientId = opts?.clientId
    this.clientSecret = opts?.clientSecret
    this.logger = opts?.logger ?? (console as unknown as Logger)
  }

  /**
   * Refresh the OAuth token if it has expired or is about to expire.
   * Requires refreshToken, clientId, and clientSecret.
   */
  private async ensureValidToken(): Promise<void> {
    if (!(this.refreshToken && this.clientId && this.clientSecret)) return
    if (this.expiresAt == null) return

    const now = Date.now()
    if (now < this.expiresAt - REFRESH_BUFFER_MS) return

    // Clear expired cooldown promise so a new refresh can start
    if (this.refreshPromise && this.refreshSuccessTime && now >= this.refreshSuccessTime + REFRESH_COOLDOWN_MS) {
      this.refreshPromise = null
    }

    // Coalesce: if a refresh is in progress or within cooldown, await it
    if (this.refreshPromise) {
      await this.refreshPromise
      return
    }

    this.refreshPromise = this.doTokenRefresh()
    await this.refreshPromise
  }

  private async doTokenRefresh(): Promise<void> {
    // Guarded by ensureValidToken: refreshToken, clientId, clientSecret are all truthy
    const clientId = this.clientId as string
    const clientSecret = this.clientSecret as string
    const refreshToken = this.refreshToken as string

    try {
      const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Linear token refresh failed (${res.status}): ${text}`)
      }

      const data = (await res.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }

      this.accessToken = data.access_token
      if (data.refresh_token) this.refreshToken = data.refresh_token
      this.expiresAt = Date.now() + data.expires_in * 1000

      this.persistToken()
      this.refreshSuccessTime = Date.now()
      // On success: keep refreshPromise alive for cooldown period.
      // Late-arriving 401s will await this resolved promise instead of triggering a new refresh.
    } catch (err) {
      // On failure: clear immediately so next request can retry fresh
      this.refreshPromise = null
      throw err
    }
  }

  /**
   * Persist refreshed token back to Cyrus config to keep it in sync.
   */
  private persistToken(): void {
    // Persist to plugin-local storage only
    try {
      writeStoredToken(
        {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
        },
        this.logger,
      )
    } catch {
      // Best-effort
    }
  }

  /**
   * Strip token-like values and workspace secrets from log output.
   */
  private sanitize(text: string): string {
    // Remove Bearer tokens and long hex/base64 strings that look like tokens
    return text
      .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
      .replace(/(?:access_token|refresh_token|token|secret|apiKey|api_key)["\s:=]+[^\s"',}]{20,}/gi, "$1=[redacted]")
  }

  private authHeader(): string {
    // OAuth tokens require Bearer prefix; personal API keys do not
    return this.refreshToken ? `Bearer ${this.accessToken}` : this.accessToken
  }

  private async gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    await this.ensureValidToken()

    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader(),
      },
      body: JSON.stringify({ query, variables }),
    })

    // On 401, force a refresh and retry once
    if (res.status === 401 && this.refreshToken) {
      this.expiresAt = 0 // force refresh
      await this.ensureValidToken()

      const retry = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader(),
        },
        body: JSON.stringify({ query, variables }),
      })

      if (!retry.ok) {
        const text = await retry.text()
        this.logger.error(`Linear API ${retry.status} (after refresh): ${this.sanitize(text)}`)
        throw new Error(`Linear API request failed (${retry.status})`)
      }

      const payload = await retry.json()
      if (payload.errors?.length) {
        if (!payload.data) {
          this.logger.error(`Linear GraphQL errors (after refresh): ${JSON.stringify(payload.errors)}`)
          throw new Error("Linear GraphQL request failed (see server logs)")
        }
        this.logger.warn(`Linear GraphQL partial errors (after refresh): ${JSON.stringify(payload.errors)}`)
      }

      return payload.data as T
    }

    if (!res.ok) {
      const text = await res.text()
      this.logger.error(`Linear API ${res.status}: ${this.sanitize(text)}`)
      throw new Error(`Linear API request failed (${res.status})`)
    }

    const payload = await res.json()
    if (payload.errors?.length) {
      if (!payload.data) {
        this.logger.error(`Linear GraphQL errors: ${JSON.stringify(payload.errors)}`)
        throw new Error("Linear GraphQL request failed (see server logs)")
      }
      this.logger.warn(`Linear GraphQL partial errors: ${JSON.stringify(payload.errors)}`)
    }

    return payload.data as T
  }

  async emitActivity(agentSessionId: string, content: ActivityContent): Promise<void> {
    const input: Record<string, unknown> = {
      agentSessionId,
      content,
    }
    await this.gql(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      { input },
    )
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string } }
    }>(
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }`,
      { input: { issueId, body } },
    )
    return data.commentCreate.comment.id
  }

  async getIssueDetails(issueId: string): Promise<{
    id: string
    identifier: string
    title: string
    description: string | null
    state: { name: string; type: string }
    creator: { name: string; email: string | null } | null
    assignee: { name: string } | null
    labels: { nodes: Array<{ id: string; name: string }> }
    team: { id: string; key: string; name: string }
    comments: { nodes: Array<{ id: string; body: string; user: { name: string } | null; createdAt: string }> }
    project: { id: string; name: string } | null
    url: string
  }> {
    const data = await this.gql<{ issue: any }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state { name type }
          creator { name email }
          assignee { name }
          labels { nodes { id name } }
          team { id key name }
          comments(last: 10) {
            nodes {
              id
              body
              user { name }
              createdAt
            }
          }
          project { id name }
          url
        }
      }`,
      { id: issueId },
    )
    return data.issue
  }

  async updateIssueState(issueId: string, stateName: string): Promise<boolean> {
    // Fetch issue's team ID + team states in a single GraphQL query via nesting
    const data = await this.gql<{
      issue: {
        team: { id: string; states: { nodes: Array<{ id: string; name: string }> } } | null
      }
    }>(
      `query IssueTeamStates($id: String!) {
        issue(id: $id) {
          team {
            id
            states { nodes { id name } }
          }
        }
      }`,
      { id: issueId },
    )

    const team = data.issue.team
    if (!team) throw new Error(`Cannot find team for issue ${issueId}`)

    // Update cache with freshly fetched states
    this.teamStatesCache.set(team.id, { nodes: team.states.nodes, fetchedAt: Date.now() })

    const state = team.states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase())

    if (!state) {
      throw new Error(
        `State "${stateName}" not found in team ${team.id}. Available: ${team.states.nodes.map((s) => s.name).join(", ")}`,
      )
    }

    const updateData = await this.gql<{
      issueUpdate: { success: boolean }
    }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input: { stateId: state.id } },
    )

    return updateData.issueUpdate.success
  }

  async getTeams(): Promise<Array<{ id: string; name: string; key: string }>> {
    const data = await this.gql<{
      teams: { nodes: Array<{ id: string; name: string; key: string }> }
    }>(`query { teams { nodes { id name key } } }`)
    return data.teams.nodes
  }
}
