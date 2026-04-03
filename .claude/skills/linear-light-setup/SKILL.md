---
name: linear-light-setup
description: Guide users through setting up the OpenClaw Linear integration plugin. Use when the user wants to configure Linear webhooks, set up OAuth, manage issue state transitions, or needs help with the openclaw-linear-light plugin installation and configuration workflow.
---

# Linear Light Plugin Setup

Guide users through configuring the `openclaw-linear-light` plugin for OpenClaw.

## Prerequisites

Before starting, confirm the user has:
- An OpenClaw gateway running and accessible
- A public URL pointing to the gateway (Cloudflare Tunnel, ngrok, etc.)
- A Linear workspace with admin access

## Phase 1: Create a Linear OAuth App

Direct the user to Linear's settings:

1. Go to **Linear → Settings → API → OAuth Applications → Create new**
2. Fill in:
   - **Name**: Their agent name (e.g. "OpenClaw Agent")
   - **Redirect URL**: `https://<gateway-host>/linear-light/oauth/callback`
   - **Webhook URL**: `https://<gateway-host>/linear-light/webhook`
   - **Webhook**: Enabled
   - **Event types**: Agent session events, Issues
3. After creating, note:
   - **Client ID** → needed for `linearClientId`
   - **Client Secret** → needed for `linearClientSecret`
   - **Webhook Signing Secret** → needed for `webhookSecret`

## Phase 2: Install and Configure

1. Install the plugin:
   ```bash
   openclaw plugins install ./openclaw-linear-light
   ```

2. Add configuration to `openclaw.config.json5`:
   ```json5
   {
     plugins: {
       entries: {
         "linear-light": {
           config: {
             enabled: true,
             webhookSecret: "<webhook signing secret>",
             mentionTrigger: "Linus",
             autoInProgress: true,
             linearClientId: "<OAuth client ID>",
             linearClientSecret: "<OAuth client secret>",
           }
         }
       }
     }
   }
   ```

3. Restart the gateway:
   ```bash
   openclaw gateway restart
   ```

## Phase 3: Authorize

1. Visit `https://<gateway-host>/linear-light/oauth/init` to start OAuth
2. After authorization, the token is stored automatically at `~/.openclaw/plugins/linear-light/token.json`

## Phase 4: Verify

1. Check health: `GET https://<gateway-host>/linear-light/status`
2. Expected response:
   ```json
   {
     "status": "ok",
     "version": "0.1.0",
     "configured": { "webhook": true, "oauth": true, "token": true },
     "errors": [],
     "warnings": []
   }
   ```
3. If `status` is `"degraded"`, check `errors` and `warnings` for actionable guidance.

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Disable the plugin |
| `webhookSecret` | `string` | — | **Required.** Linear webhook signing secret |
| `mentionTrigger` | `string` | `"Linus"` | Text that triggers the agent in comments |
| `autoInProgress` | `boolean` | `true` | Auto-set issue to "In Progress" when agent starts |
| `agentIdentity` | `string` | *(built-in)* | Custom system identity instruction for agent prompts |
| `initialResponseTemplate` | `string` | `"Received, processing {identifier}: {title}"` | Template for initial response. Supports `{identifier}` and `{title}` |
| `linearClientId` | `string` | — | **Required for OAuth.** Linear OAuth client ID |
| `linearClientSecret` | `string` | — | **Required for OAuth.** Linear OAuth client secret |

## Troubleshooting

### OAuth callback shows error
- Verify redirect URL matches exactly: `https://<host>/linear-light/oauth/callback`
- Check `linearClientId` and `linearClientSecret` match the Linear OAuth app

### Webhook returns 401
- `webhookSecret` must match the signing secret from Linear OAuth app settings

### Status shows `degraded`
- Check the `errors` array for missing required fields
- Check the `warnings` array for optional but recommended fields
- `configured.token: false` means OAuth hasn't been completed — visit `/linear-light/oauth/init`

### No agent response on issue comments
- Verify webhook URL is correct and reachable from Linear
- Check gateway logs for webhook receipt
- Ensure `mentionTrigger` matches what you type in comments (default: "Linus")

## Agent Tools

Once configured, the agent has access to:

| Tool | Description |
|------|-------------|
| `linear_update_status` | Change issue status (e.g. "In Progress", "Done", "Canceled") |
| `linear_get_issue` | Get full issue details including comments, labels, assignee, project |
| `linear_search_issues` | Search issues by query |
