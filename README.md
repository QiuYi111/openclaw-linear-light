# Linear Light

Turn every Linear issue into an AI agent session. No Slack bot, no Telegram bridge — Linear is the interface.

## Why Linear, Not Chat

Most AI agent workflows run inside chat apps. You type a request, the agent replies, the conversation scrolls away.

Linear is different.

**Issues force you to write.** Before an agent can work on something, someone has to create an issue — give it a title, write a description, assign it, set a priority. That friction is a feature. It forces the human to think clearly. Vague requests like "fix the thing" don't survive the issue creation flow.

**Status is visible.** In a chat, an agent says "I'll do it" and you hope for the best. In Linear, the issue moves from "Todo" to "In Progress" to "Done" — and everyone on the team can see it.

**Context persists.** A chat thread gets buried. An issue stays in your project, searchable, linkable, with a full comment history. You can come back three months later and understand the full arc.

**Assignment creates accountability.** When you assign an issue to a person (or an agent), there's a clear owner. No more "I thought you were doing it."

We're not saying chat is bad. Chat is great for quick questions. But for structured work that an agent should own end-to-end, the issue tracker is the right abstraction.

## Two Modes

Linear Light works in two modes, sharing the same core logic:

**OpenClaw Plugin** — runs as a plugin inside an [OpenClaw](https://github.com/nousresearch/openclaw) gateway. Uses OpenClaw's built-in agent, completion loop, and real-time activity streaming. Best if you're already on OpenClaw.

**Standalone Gateway** — runs independently, forwarding Linear webhooks to [Hermes Agent](https://hermes-agent.nousresearch.com/) or any webhook-compatible agent. No OpenClaw dependency. Best if you want a lightweight setup or prefer Hermes's skills, MCP integration, and multi-platform reply delivery.

Both modes share the same Linear API client, webhook verification, project memory, and token management. The core modules live in `src/core/`.

```
                  Linear webhook
                       │
                       ▼
              ┌────────────────┐
              │  Linear Light  │
              │  (shared core) │
              └───┬────────┬───┘
                  │        │
          OpenClaw    Standalone
          Plugin      Gateway
                  │        │
                  ▼        ▼
          OpenClaw     Hermes
          Agent        Agent
```

### Feature Comparison

| | OpenClaw Plugin | Standalone Gateway |
|---|---|---|
| Real-time activity streaming | Yes | No |
| Completion loop | Built-in | Via Hermes cron |
| Multi-platform reply | Linear only | 15+ platforms (Hermes) |
| MCP / Skills / Memory | OpenClaw's | Hermes's |
| Zero external deps | Yes | Yes (Node.js built-ins) |
| Requires OpenClaw | Yes | No |
| Requires Hermes | No | Yes |

## How It Works

```
Linear issue trigger (@mention or agent session)
       │
       ▼
  Webhook (HMAC-SHA256 signed, deduped)
       │
       ▼
  Agent session — one per issue
       │
       ├─ thoughts / tool calls → Linear agent session UI (OpenClaw mode)
       └─ final reply → comment on the issue
```

Each issue maps to one persistent session. Follow-up comments continue the conversation. The agent has full tool access — Linear API, file system, terminal, web, whatever its backend provides.

## Project Memory

An agent session starts fresh every time. If an issue sits dormant for a week and someone adds a follow-up comment, the agent wakes up with no memory of what happened before.

Project memory solves this. When an issue belongs to a Linear project, the plugin maintains a directory on your local machine:

```
~/clawd/projects/<project-name>-<hash>/
├── AGENTS.md     # Project rules — the agent reads this first
├── Context.md    # Current state, decisions, findings — the agent writes this
├── README.md     # Project purpose and background
└── issues/       # Conversation records, auto-synced from Linear
```

Before starting work, the agent reads `Context.md`. When it makes progress, it updates `Context.md` and commits to git.

This is deliberately simple. No database, no vector store, no embedding model. Just markdown files. It works because:

1. **The agent is both reader and writer.** No search or retrieval needed — it reads the whole file.
2. **Git provides versioning.** Every update is a commit. Diff, revert, see the evolution.
3. **Self-documenting structure.** `AGENTS.md` = read this first. `Context.md` = here's what we know.
4. **Local and private.** Nothing leaves your filesystem.

We tried more complex approaches. This is the one that stuck.

## Completion Loop (OpenClaw Mode)

In chat, you'd nudge the agent: "hey, are you done?" In Linear, there's nobody watching.

The completion loop checks every N minutes (default 10) whether the issue is still in a non-terminal state. If it is, it sends the agent a prompt to continue. The loop stops at "Done" or "Canceled."

- Agent doesn't silently give up after timeouts
- Multi-step tasks complete without human intervention
- State persists to disk — survives gateway restarts

In standalone mode, use Hermes's built-in cron scheduler for the same effect.

## Standalone Gateway

Run Linear Light without OpenClaw:

```bash
# Install
git clone https://github.com/QiuYi111/linear-light.git
cd linear-light
npm install

# Configure — create ~/.linear-gateway/config.json or use env vars
# Required: LINEAR_WEBHOOK_SECRET, HERMES_WEBHOOK_URL, HERMES_ROUTE_SECRET

# Start
npx tsx src/standalone/index.ts

# Or install globally for the CLI
npm link
linear watchdog --fix     # Health check + auto-repair
```

The standalone gateway includes:

- **Anti-loop protection** — terminal state guard prevents dispatching on already-completed issues
- **Token management** — OAuth flow with automatic refresh
- **Watchdog** — `linear watchdog` checks token validity, gateway health, and network connectivity; `--fix` attempts auto-repair

### Standalone Config

Config file at `~/.linear-gateway/config.json` (or env vars):

| Field | Env Var | Description |
|---|---|---|
| `port` | `LINEAR_GATEWAY_PORT` | HTTP port (default: 8091) |
| `linear.webhookSecret` | `LINEAR_WEBHOOK_SECRET` | Linear webhook signing secret |
| `linear.clientId` | `LINEAR_CLIENT_ID` | Linear OAuth client ID |
| `linear.clientSecret` | `LINEAR_CLIENT_SECRET` | Linear OAuth client secret |
| `hermes.webhookUrl` | `HERMES_WEBHOOK_URL` | Hermes webhook endpoint |
| `hermes.routeSecret` | `HERMES_ROUTE_SECRET` | HMAC secret for Hermes payloads |
| `hermes.timeoutMs` | `HERMES_TIMEOUT_MS` | Request timeout (default: 30000) |
| `botUserId` | `LINEAR_BOT_USER_ID` | Bot's Linear user ID (for self-filtering) |
| `tokenStorePath` | — | Token file path (default: `~/.linear-gateway/token.json`) |

## Security

We take input from the internet (webhooks) and send it to an LLM. That's a trust boundary:

- **Webhook signatures** — HMAC-SHA256 on every incoming payload. Unsigned requests are rejected.
- **Prompt sanitization** — user-controlled text is sanitized before embedding in agent prompts. Template injection patterns (`${var}`, `{placeholder}`) are neutralized.
- **Token management** — atomic write-then-rename storage. Coalesced refresh: concurrent requests share one in-flight promise.
- **Dedup** — TTL-based map. Each webhook event processed at most once.
- **No runtime dependencies** — Node.js built-ins only. No express, no axios, no lodash.

## Agent Tools

Tools the agent can call while working on an issue:

| Tool | Description |
|---|---|
| `linear_update_status` | Change issue status (In Progress, Done, etc.) |
| `linear_get_issue` | Full issue details — comments, labels, assignee, project |
| `linear_search_issues` | Search issues by query |
| `project_memory_save` | Save to project memory files + git commit |

## OpenClaw Plugin Setup

### One-Prompt Setup

Paste this to your coding agent:

`````
Install and configure the openclaw-linear-light plugin for my OpenClaw gateway.

My setup:
- Gateway host: <your-gateway-host>
- Linear workspace: <your-workspace-name>

Steps:
1. Clone https://github.com/QiuYi111/linear-light
2. Install the skill
3. /linear-light-setup
4. Verify: `GET https://<your-gateway-host>/linear-light/status` should return `"status": "ok"`
````

### Manual Setup

1. **Create a Linear OAuth app** — Settings → API → OAuth Applications → Create new
   - Redirect URL: `https://<your-gateway-host>/linear-light/oauth/callback`
   - Webhook URL: `https://<your-gateway-host>/linear-light/webhook`
   - Subscribe to Issues and Agent Session events

2. **Install the plugin**
   ```bash
   openclaw plugins install ./linear-light
   openclaw gateway restart
   ```

3. **Configure** — add to your `openclaw.config.json5`:
   ```json5
   {
     plugins: {
       entries: {
         "linear-light": {
           config: {
             enabled: true,
             webhookSecret: "${LINEAR_WEBHOOK_SECRET}",
             mentionTrigger: "Linus",
             autoInProgress: true,
             completionLoopEnabled: true,
             completionLoopInterval: 10,
           }
         }
       }
     }
   }
   ```

4. **Expose your gateway** — Cloudflare Tunnel or ngrok:
   ```bash
   cloudflared tunnel --url http://localhost:18789
   ```

5. **Authorize** — visit `/linear-light/oauth/init`

6. **Verify** — `GET /linear-light/status` should return `"status": "ok"`

### OpenClaw Plugin Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Disable the plugin |
| `webhookSecret` | string | — | **Required.** Linear webhook signing secret |
| `mentionTrigger` | string | `"Linus"` | Text that triggers the agent in comments |
| `autoInProgress` | boolean | `true` | Auto-set "In Progress" on agent start |
| `completionLoopEnabled` | boolean | `true` | Enable periodic completion checks |
| `completionLoopInterval` | number | `10` | Loop interval in minutes (min 1) |
| `completionLoopMaxIterations` | number | `0` | Max iterations (0 = unlimited) |
| `agentIdentity` | string | *(see below)* | System identity for agent prompts |
| `initialResponseTemplate` | string | `"Received, processing {identifier}: {title}"` | Initial activity response |
| `linearClientId` | string | — | **Required for OAuth.** |
| `linearClientSecret` | string | — | **Required for OAuth.** |
| `projectMemoryEnabled` | boolean | `true` | Enable project memory persistence |
| `projectMemoryBasePath` | string | `~/clawd/projects` | Base path for project directories |
| `dispatchMode` | string | `"openclaw"` | `"openclaw"` or `"hermes"` |
| `hermes.webhookUrl` | string | — | Hermes webhook endpoint URL |
| `hermes.webhookSecret` | string | — | HMAC secret for Hermes payloads |
| `hermes.routeName` | string | `"linear"` | Hermes webhook route name |
| `hermes.timeoutMs` | number | `15000` | Request timeout in ms |

## Hermes Agent Setup

To use standalone mode or the Hermes dispatch mode in the OpenClaw plugin:

1. **Install Hermes** — follow the [Hermes installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation)

2. **Add Linear API token** — copy from `~/.linear-gateway/token.json` to `~/.hermes/.env`:
   ```
   LINEAR_API_TOKEN=<token>
   ```

3. **Install the Linear Workflow Skill** — copy `docs/hermes-skill.md` to `~/.hermes/skills/linear-workflow/SKILL.md`

4. **Configure Hermes webhook route** in `~/.hermes/config.yaml`:
   ```yaml
   platforms:
     webhook:
       enabled: true
       extra:
         port: 8644
         secret: "your-hermes-webhook-secret"
         routes:
           linear:
             secret: "your-hermes-webhook-secret"
             prompt: "{prompt}"
             skills: ["linear-workflow"]
             deliver: "log"
   ```

5. **Restart both** — `hermes gateway restart` and (if using plugin mode) `openclaw gateway restart`

## Development

```bash
npm install            # dev dependencies
npm run lint           # biome check
npm run typecheck      # tsc --noEmit
npm run test           # vitest
npm run test:coverage  # vitest --coverage (threshold: 90%)
npm run check          # lint + typecheck + test
```

Zero runtime dependencies. TypeScript strict mode. ESM only. 95%+ test coverage.

## Troubleshooting

### "no access token" at startup
Visit `/linear-light/oauth/init` to start the OAuth flow.

### Webhook returns 401
Check that `webhookSecret` matches the signing secret in your Linear OAuth app settings.

### Completion loop spins after gateway restart
Ensure you're on a version that includes the fallback context fix ([#126](https://github.com/QiuYi111/linear-light/pull/126)).

### Watchdog reports unhealthy
Run `linear watchdog --fix` to attempt auto-repair. Check `~/.linear-gateway/token.json` for token validity.

## Credits

Infrastructure borrowed from:
- [openclaw-linear-plugin](https://github.com/calltelemetry/openclaw-linear-plugin) — webhook handling, Linear GraphQL API, dedup
- [cyrus](https://github.com/ceedaragents/cyrus) — webhook verification, message translation patterns

## License

MIT
