# Linear Light

A channel-mode plugin for [OpenClaw](https://github.com/ceedaragents/openclaw) that turns every Linear issue into an interactive AI agent session.

Zero runtime dependencies. Built entirely on Node.js built-ins.

## Overview

Linear is registered as a first-class OpenClaw channel. When a user triggers the agent on a Linear issue (via @mention or agent session), the plugin:

1. Receives the webhook event from Linear (HMAC-SHA256 verified, deduped)
2. Dispatches the message to the OpenClaw agent via the channel system
3. Streams agent activity (thoughts, tool calls, responses) to Linear's agent session UI in real time
4. Posts the agent's final reply as a comment on the issue

Each issue maps to one persistent session, so follow-up comments continue the conversation naturally.

```
Linear @mention / agent session
              │
              ▼
     Webhook (signed, deduped)
              │
              ▼
  dispatchInboundReplyWithBase()
              │
              ▼
     OpenClaw agent session
              │
              ├── thought / action → emitActivity() → Linear Agent Session UI
              └── final reply → createComment() → Linear issue thread
```

## Features

- **Channel-mode architecture** — Linear is a native OpenClaw channel, not a standalone bot
- **Agent session support** — Integrates with Linear's built-in agent session framework
- **Comment fallback** — Also supports @mention triggers via regular comments
- **Session continuity** — Each issue = one session; follow-up comments pick up where you left off
- **Real-time activity streaming** — Thoughts, tool calls, and progress appear in Linear's agent session UI
- **Auto status management** — Issues automatically move to "In Progress" when the agent starts working
- **Built-in tools** — The agent can update issue status, query issue details, and search across issues
- **OAuth with PKCE** — Secure token flow with automatic refresh
- **Zero runtime dependencies** — Only uses Node.js built-ins

## Agent Tools

| Tool | Description |
|------|-------------|
| `linear_update_status` | Change issue status (e.g. "In Progress", "Done", "Canceled") |
| `linear_get_issue` | Get full issue details including comments, labels, assignee, project |
| `linear_search_issues` | Search issues by query |

## Prerequisites

- [OpenClaw](https://github.com/ceedaragents/openclaw) gateway running and accessible
- A public URL pointing to your gateway (Cloudflare Tunnel, ngrok, etc.)
- A Linear workspace with admin access

## Quick Start

### 1. Create a Linear OAuth App

Go to **Linear → Settings → API → OAuth Applications → Create new**:

| Field | Value |
|-------|-------|
| Name | Your agent name |
| Redirect URL | `https://<your-gateway-host>/linear-light/oauth/callback` |
| Webhook URL | `https://<your-gateway-host>/linear-light/webhook` |
| Webhook | Enabled |
| Event types | Agent session events, Issues |

After creating, note the **Client ID**, **Client Secret**, and **Webhook Signing Secret**.

### 2. Install the Plugin

```bash
openclaw plugins install ./openclaw-linear-light
openclaw gateway restart
```

### 3. Configure

Add to your OpenClaw config (`openclaw.config.json5`):

```json5
{
  plugins: {
    entries: {
      "linear-light": {
        config: {
          enabled: true,
          webhookSecret: "<your webhook signing secret>",
          mentionTrigger: "Linus",
          autoInProgress: true,
          linearClientId: "<your OAuth client ID>",
          linearClientSecret: "<your OAuth client secret>",
        }
      }
    }
  }
}
```

### 4. Authorize

Visit `https://<your-gateway-host>/linear-light/oauth/init` to start the OAuth flow. After authorization, the token is stored automatically and refreshed as needed.

### 5. Expose Your Gateway

Use a tunnel to make your gateway reachable from Linear:

```bash
cloudflared tunnel --url http://localhost:18789
```

## Configuration Reference

All options are optional except where noted.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Disable the plugin entirely |
| `webhookSecret` | `string` | — | **Required.** Linear webhook signing secret |
| `mentionTrigger` | `string` | `"Linus"` | Text that triggers the agent in comments |
| `autoInProgress` | `boolean` | `true` | Auto-set issue to "In Progress" when agent starts |
| `agentIdentity` | `string` | *(see default)* | Custom system identity injected into agent prompts. Default instructs the agent not to use a personal assistant identity and lists available tools. |
| `initialResponseTemplate` | `string` | `"Received, processing {identifier}: {title}"` | Template for the initial activity response. Supports `{identifier}` and `{title}` placeholders. |
| `linearClientId` | `string` | — | **Required for OAuth.** Linear OAuth client ID |
| `linearClientSecret` | `string` | — | **Required for OAuth.** Linear OAuth client secret |

## Health Check

The plugin exposes a `/linear-light/status` endpoint that reports configuration health. It works even without a valid access token.

**Request:**

```
GET /linear-light/status
```

**Response (200):**

```json
{
  "status": "ok" | "degraded",
  "version": "0.1.0",
  "configured": {
    "webhook": true,
    "oauth": true,
    "token": true
  },
  "errors": [],
  "warnings": []
}
```

- `status: "ok"` — fully configured with a valid token
- `status: "degraded"` — missing config or no token; check `errors` and `warnings`
- `configured.webhook` — `webhookSecret` is set
- `configured.oauth` — both `linearClientId` and `linearClientSecret` are set
- `configured.token` — a Linear API token is available (OAuth or manual)

## Troubleshooting

### "no access token" at startup

The plugin can't find a Linear API token. Visit `/linear-light/oauth/init` to start the OAuth flow, or set `accessToken` in plugin config.

### "Missing webhookSecret" in status

Find your webhook signing secret in **Linear → Settings → API → OAuth Applications → [your app] → Webhook Signing Secret** and set it in your config.

### OAuth callback shows an error

- Verify `linearClientId` and `linearClientSecret` match your Linear OAuth app
- Check that the redirect URL is `https://<your-gateway-host>/linear-light/oauth/callback`
- Ensure your gateway is reachable from the internet

### Webhook returns 401

The webhook signature verification failed. Check that `webhookSecret` matches the signing secret from your Linear OAuth app settings.

### Status shows `degraded` but token exists

If `configured.token` is `true` but status is still `degraded`, check `errors` — likely `webhookSecret` is missing.

## Token Management

The plugin resolves Linear API tokens in this order:

1. **Plugin-local OAuth token** — `~/.openclaw/plugins/linear-light/token.json` (auto-created after OAuth)
2. **Plugin config** — `accessToken` field in plugin config (for manual setup)

OAuth tokens are automatically refreshed before expiry and persisted back to disk.

## Project Structure

```
openclaw-linear-light/
├── index.ts                  # Plugin entry — channel registration, tools, lifecycle hooks
├── openclaw.plugin.json      # Plugin manifest & config schema
├── src/
│   ├── config-validation.ts  # Config validation with actionable error messages
│   ├── webhook-handler.ts    # Webhook receiving, signature verification, dispatch
│   ├── oauth-handler.ts      # OAuth PKCE flow (init + callback)
│   ├── activity-stream.ts    # Real-time activity streaming to Linear agent sessions
│   ├── runtime.ts            # Shared runtime store (PluginRuntime, LinearAgentApi)
│   ├── utils.ts              # Shared utility functions
│   └── api/
│       ├── linear-api.ts     # Linear GraphQL client with token refresh
│       ├── oauth-store.ts    # OAuth token persistence (atomic write)
│       └── oauth-state-store.ts  # PKCE state persistence
└── src/__test__/             # Vitest test suite
```

## Development

```bash
npm install            # install dev dependencies
npm run lint           # biome check
npm run typecheck      # tsc --noEmit
npm run test           # vitest
npm run test:coverage  # vitest with coverage (threshold: 90%)
npm run check          # lint + typecheck + test
```

## License

MIT
