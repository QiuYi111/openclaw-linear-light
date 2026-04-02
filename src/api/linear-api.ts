/**
 * Linear API wrapper for OpenClaw Linear Light plugin
 *
 * Lightweight GraphQL client for Linear API.
 * Borrowed from openclaw-linear-plugin (calltelemetry/openclaw-linear-plugin).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token"
const CYRUS_CONFIG_PATH = join(homedir(), ".cyrus", "config.json")
const REFRESH_BUFFER_MS = 60_000 // refresh 60s before expiry

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
  source: "config" | "env" | "cyrus" | "none"
} {
  // 1. Plugin config
  const fromConfig = pluginConfig?.accessToken
  if (typeof fromConfig === "string" && fromConfig) {
    return { accessToken: fromConfig, source: "config" }
  }

  // 2. Cyrus config (~/.cyrus/config.json) — reuse existing OAuth token
  try {
    const cyrusConfig = JSON.parse(readFileSync(CYRUS_CONFIG_PATH, "utf8"))

    const workspaces = cyrusConfig?.linearWorkspaces
    if (workspaces) {
      const firstWorkspace = Object.values(workspaces)[0] as any
      if (firstWorkspace?.linearToken) {
        return {
          accessToken: firstWorkspace.linearToken,
          refreshToken: firstWorkspace.linearRefreshToken,
          expiresAt: firstWorkspace.linearTokenExpiresAt,
          source: "cyrus",
        }
      }
    }
  } catch {
    // Cyrus config not available
  }

  // 3. Env var
  const fromEnv = process.env.LINEAR_ACCESS_TOKEN ?? process.env.LINEAR_API_KEY
  if (fromEnv) {
    return { accessToken: fromEnv, source: "env" }
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
  private tokenSource?: string

  constructor(
    accessToken: string,
    opts?: {
      refreshToken?: string
      expiresAt?: number
      clientId?: string
      clientSecret?: string
      source?: string
    },
  ) {
    this.accessToken = accessToken
    this.refreshToken = opts?.refreshToken
    this.expiresAt = opts?.expiresAt
    this.clientId = opts?.clientId
    this.clientSecret = opts?.clientSecret
    this.tokenSource = opts?.source
  }

  /**
   * Refresh the OAuth token if it has expired or is about to expire.
   * Requires refreshToken, clientId, and clientSecret.
   */
  private async ensureValidToken(): Promise<void> {
    if (!(this.refreshToken && this.clientId && this.clientSecret)) return
    if (this.expiresAt == null) return
    if (Date.now() < this.expiresAt - REFRESH_BUFFER_MS) return

    const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
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
  }

  /**
   * Persist refreshed token back to Cyrus config to keep it in sync.
   */
  private persistToken(): void {
    if (this.tokenSource !== "cyrus") return

    try {
      const raw = readFileSync(CYRUS_CONFIG_PATH, "utf8")
      const store = JSON.parse(raw)
      const workspaces = store?.linearWorkspaces
      if (!workspaces) return

      const firstKey = Object.keys(workspaces)[0]
      if (!firstKey) return

      workspaces[firstKey].linearToken = this.accessToken
      if (this.refreshToken) {
        workspaces[firstKey].linearRefreshToken = this.refreshToken
      }
      if (this.expiresAt) {
        workspaces[firstKey].linearTokenExpiresAt = this.expiresAt
      }

      writeFileSync(CYRUS_CONFIG_PATH, JSON.stringify(store, null, 2), "utf8")
    } catch {
      // Best-effort persistence
    }
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
        throw new Error(`Linear API ${retry.status}: ${text}`)
      }

      const payload = await retry.json()
      if (payload.errors?.length) {
        console.warn(`Linear GraphQL partial errors: ${JSON.stringify(payload.errors)}`)
        if (!payload.data) {
          throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`)
        }
      }

      return payload.data as T
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Linear API ${res.status}: ${text}`)
    }

    const payload = await res.json()
    if (payload.errors?.length) {
      console.warn(`Linear GraphQL partial errors: ${JSON.stringify(payload.errors)}`)
      if (!payload.data) {
        throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`)
      }
    }

    return payload.data as T
  }

  async emitActivity(agentSessionId: string, content: ActivityContent): Promise<void> {
    await this.gql(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      { input: { agentSessionId, content } },
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
    // First, get the team to find the state ID
    const issue = await this.getIssueDetails(issueId)
    const teamId = issue.team?.id
    if (!teamId) throw new Error(`Cannot find team for issue ${issueId}`)

    const statesData = await this.gql<{
      team: { states: { nodes: Array<{ id: string; name: string }> } }
    }>(
      `query TeamStates($id: String!) {
        team(id: $id) {
          states { nodes { id name } }
        }
      }`,
      { id: teamId },
    )

    const state = statesData.team.states.nodes.find((s: any) => s.name.toLowerCase() === stateName.toLowerCase())

    if (!state) {
      throw new Error(
        `State "${stateName}" not found in team ${teamId}. Available: ${statesData.team.states.nodes.map((s: any) => s.name).join(", ")}`,
      )
    }

    const data = await this.gql<{
      issueUpdate: { success: boolean }
    }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input: { stateId: state.id } },
    )

    return data.issueUpdate.success
  }

  async getTeams(): Promise<Array<{ id: string; name: string; key: string }>> {
    const data = await this.gql<{
      teams: { nodes: Array<{ id: string; name: string; key: string }> }
    }>(`query { teams { nodes { id name key } } }`)
    return data.teams.nodes
  }
}
