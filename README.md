# openclaw-linear-light

Lightweight Linear integration for OpenClaw — turn Linear issues into task sessions with status management.

## What it does

- **@mention triggers** — When you @mention the agent in a Linear comment, it starts an agent session
- **Session continuity** — Follow-up comments in the same issue thread continue the conversation
- **Status management** — Automatically sets issues to "In Progress" when work starts
- **Completion notifications** — Sends a notification (Telegram) when the agent finishes, for review
- **Agent tools** — The agent gets `linear_comment`, `linear_update_status`, `linear_get_issue` tools

## Architecture

```
Linear @mention → Gateway /linear-light/webhook
                        │
                        ▼
              Filter + dedup
                        │
                        ▼
         sessionKey = "linear:{issueId}"
              → OpenClaw agent session
                        │
              ├─ Start → In Progress
              ├─ Done → Telegram notification
              └─ Reply → linear_comment()
```

## Setup

### 1. Install as OpenClaw plugin

```bash
openclaw plugins install ./openclaw-linear-light
openclaw gateway restart
```

### 2. Configure

Add to your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "linear-light": {
        config: {
          enabled: true,
          webhookSecret: "${LINEAR_WEBHOOK_SECRET}",
          mentionTrigger: "Linus",  // or whatever your agent is called
          autoInProgress: true,
          notifyOnComplete: true,
          notificationChannel: "telegram",
          notificationTarget: "8569595684",
        }
      }
    }
  }
}
```

### 3. Linear OAuth App

1. Go to Linear → Settings → API → OAuth Applications → Create new
2. Fill in:
   - **Name**: Your agent name
   - **Redirect URL**: `https://<your-tunnel>/linear/oauth/callback`
   - **Webhook URL**: `https://<your-tunnel>/linear-light/webhook`
   - **Webhook**: ✓ enabled
   - **Event types**: ✓ Agent session events, ✓ Issues
3. Set `LINEAR_WEBHOOK_SECRET` to the webhook signing secret

### 4. Public endpoint

Use Cloudflare Tunnel or ngrok to expose your gateway:

```bash
cloudflared tunnel --url http://localhost:18789
```

## Token resolution

The plugin resolves Linear API tokens in order:
1. Plugin config `accessToken`
2. Cyrus config (`~/.cyrus/config.json`) — reuses existing OAuth tokens
3. `LINEAR_ACCESS_TOKEN` env var

## Credits

Infrastructure borrowed from:
- [openclaw-linear-plugin](https://github.com/calltelemetry/openclaw-linear-plugin) — webhook handling, Linear GraphQL API, dedup
- [cyrus](https://github.com/ceedaragents/cyrus) — webhook verification, message translation patterns

## License

MIT
