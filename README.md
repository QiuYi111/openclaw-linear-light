# Linear Light

Turn every Linear issue into an AI agent session. No Slack bot, no Telegram bridge — Linear is the interface.

## Why Linear, Not Chat

Most AI agent workflows run inside chat apps: Telegram, Slack, Feishu. You type a request, the agent replies, the conversation scrolls away.

Linear is different. Here's why that matters for agent work:

**Issues force you to write.** Before an agent can work on something, someone has to create an issue — give it a title, write a description, assign it, set a priority. That friction is a feature. It forces the human to think clearly about what they want. Vague requests like "fix the thing" don't survive the issue creation flow.

**Status is visible.** In a chat, an agent says "I'll do it" and you hope for the best. In Linear, the issue moves from "Todo" to "In Progress" to "Done" — and everyone on the team can see it. The status board is a shared understanding of what's happening.

**Context persists.** A chat thread gets buried. An issue stays in your project, searchable, linkable, with a full comment history of what the agent did and why. You can come back to it three months later and understand the full arc.

**Assignment creates accountability.** When you assign an issue to a person (or an agent), there's a clear owner. No more "I thought you were doing it" — the assignee field settles it.

We're not saying chat is bad. Chat is great for quick questions and casual collaboration. But for structured work that an agent should own end-to-end, the issue tracker is the right abstraction.

## How It Works

Linear is registered as a first-class OpenClaw channel. When you trigger the agent on an issue — via @mention or Linear's built-in agent sessions — the plugin receives a webhook, dispatches the message to the agent, and posts the reply back as a comment.

```
Linear issue trigger
       │
       ▼
  Webhook (signed, deduped)
       │
       ▼
  OpenClaw agent session
       │
       ├─ thoughts / tool calls → Linear agent session UI (real-time)
       └─ final reply → comment on the issue
```

Each issue maps to one persistent session. Follow-up comments continue the conversation. The agent has access to all its tools, skills, and memory — the same capabilities it has in any other channel.

## Project Memory

An agent session starts fresh every time. If an issue sits dormant for a week and someone adds a follow-up comment, the agent wakes up with no memory of what happened before.

Project memory solves this. When an issue belongs to a Linear project, the plugin automatically maintains a directory on your local machine:

```
~/clawd/projects/<project-name>-<hash>/
├── AGENTS.md     # Project rules — the agent reads this first
├── Context.md    # Current state, decisions, findings — the agent writes this
├── README.md     # Project purpose and background
└── issues/       # Conversation records, auto-synced from Linear
```

Before starting work, the agent reads `Context.md` to understand where things left off. When it makes progress, it updates `Context.md` with new findings. When the session ends, it commits and pushes to git.

It's deliberately simple. No database, no vector store, no embedding model. Just a few markdown files that the agent can read and write. This works because:

1. **The agent is the reader and writer.** It doesn't need search or retrieval — it reads the whole file. Markdown is its native format.
2. **Git provides versioning.** Every update is a commit. You can diff, revert, and see the full history of how the agent's understanding evolved.
3. **The directory structure is self-documenting.** `AGENTS.md` at the top means "read this first." `Context.md` means "here's what we know." No schema to learn.
4. **It's local and private.** Everything stays on your machine. No data leaves your filesystem.

We tried more complex approaches. This is the one that stuck.

## Completion Loop

When an agent works on an issue, it might not finish in one pass. Maybe it needs to wait for a long-running command. Maybe it gets stuck. Maybe the task is genuinely multi-step and requires multiple iterations.

In a chat, you'd just nudge the agent: "hey, are you done?" In Linear, there's nobody watching.

The completion loop is a periodic check: every N minutes (configurable, default 10), the plugin checks whether the issue is still in a non-terminal state. If it is, it sends the agent a prompt to continue working. The loop stops when the issue reaches "Done" or "Canceled."

This sounds simple. It is simple. But it solves a real problem:

- **The agent doesn't silently give up.** If a long operation times out, the next loop tick picks it up.
- **Multi-step tasks get completed.** The agent can make progress across multiple iterations without human intervention.
- **Linear needs it more than chat.** In chat, there's a human in the loop who notices when things stall. In Linear, issues can sit in "In Progress" forever. The loop is the safety net.

Loop state is persisted to disk, so it survives gateway restarts. If the server goes down and comes back up, the loop resumes and checks whether the issue is already done before prompting the agent again.

## Real-Time Activity Streaming

While the agent works, you can watch its progress in Linear's agent session UI:

- **Thoughts** — the agent's reasoning, streamed as it generates
- **Actions** — tool calls, shown as start/complete markers
- **Responses** — the final reply, posted as a permanent comment

This gives you visibility into what the agent is doing without having to open a separate terminal or dashboard. The agent session UI in Linear was designed for exactly this — we just connect to it.

## Security

We take input from the internet (webhooks) and send it to an LLM. That's a trust boundary that needs careful handling:

- **Webhook signatures** — every incoming webhook is verified with HMAC-SHA256. Malformed or unsigned payloads are rejected before any processing.
- **Prompt sanitization** — user-controlled text (issue titles, descriptions, comments) is sanitized before being embedded in agent prompts. Template injection patterns like `${variable}` and `{placeholder}` are neutralized to prevent prompt template abuse.
- **Token management** — OAuth tokens are stored with atomic write-then-rename to prevent corruption. Refresh is coalesced: concurrent requests share a single in-flight refresh promise instead of triggering multiple refresh calls.
- **Dedup** — webhook events are deduplicated with a TTL-based map. Linear may retry delivery; we process each event at most once.
- **No runtime dependencies** — the entire plugin runs on Node.js built-ins. No express, no axios, no lodash. Less surface area.
- **Sensitive config** — `webhookSecret`, `clientId`, and `clientSecret` are marked as sensitive in the plugin schema and won't appear in status endpoints or logs.

## Performance

Some things we optimized because they mattered:

- **Singleton API client** — the Linear GraphQL client is created once and reused across all requests, not instantiated per-call.
- **Team state caching** — `updateIssueState()` caches team workflow states for 5 minutes, cutting GraphQL round-trips from 3 to 2 per status update.
- **Concurrent webhook handling** — the dispatch context is stored per-issue, not in a global singleton, so multiple issues can be processed concurrently without race conditions.
- **Memory cleanup** — session maps and dedup caches are cleaned up with TTL-based sweeps, not unbounded growth.
- **Body size limits** — webhook payloads are capped at 1MB and read with a 5-second timeout to prevent resource exhaustion.

## Setup

### One Prompt Setup

Copy this prompt and paste it to your coding agent (Claude Code, Cursor, etc.):

````
Install and configure the openclaw-linear-light plugin for my OpenClaw gateway.

My setup:
- Gateway host: <your-gateway-host>
- Linear workspace: <your-workspace-name>

Steps:
1. Clone https://github.com/QiuYi111/openclaw-linear-light
2. Install the skill
3. /linear-light-setup
4. Verify: `GET https://<your-gateway-host>/linear-light/status` should return `"status": "ok"`
````

The agent will handle the rest — OAuth app creation, config generation, token verification.

### Manual Setup

If you prefer to do it yourself:

1. **Create a Linear OAuth app** — Settings → API → OAuth Applications → Create new
   - Redirect URL: `https://<your-gateway-host>/linear-light/oauth/callback`
   - Webhook URL: `https://<your-gateway-host>/linear-light/webhook`
   - Enable webhooks, subscribe to Issues and Agent Session events

2. **Install the plugin**
   ```bash
   openclaw plugins install ./openclaw-linear-light
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

4. **Expose your gateway** — use Cloudflare Tunnel or ngrok:
   ```bash
   cloudflared tunnel --url http://localhost:18789
   ```

5. **Authorize** — visit `/linear-light/oauth/init` to start the OAuth flow

6. **Verify** — `GET /linear-light/status` should return `"status": "ok"`

## Agent Tools

| Tool | Description |
|------|-------------|
| `linear_update_status` | Change issue status (e.g. "In Progress", "Done") |
| `linear_get_issue` | Get full issue details — comments, labels, assignee, project |
| `linear_search_issues` | Search issues by query |
| `project_memory_save` | Save content to project memory files and git commit |

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Disable the plugin |
| `webhookSecret` | `string` | — | **Required.** Linear webhook signing secret |
| `mentionTrigger` | `string` | `"Linus"` | Text that triggers the agent in comments |
| `autoInProgress` | `boolean` | `true` | Auto-set issue to "In Progress" on agent start |
| `completionLoopEnabled` | `boolean` | `true` | Enable periodic completion checks |
| `completionLoopInterval` | `number` | `10` | Loop interval in minutes (minimum 1) |
| `completionLoopMaxIterations` | `number` | `0` | Max iterations before stopping (0 = unlimited) |
| `agentIdentity` | `string` | *(see below)* | System identity injected into agent prompts |
| `initialResponseTemplate` | `string` | `"Received, processing {identifier}: {title}"` | Initial activity response template |
| `linearClientId` | `string` | — | **Required for OAuth.** Linear OAuth client ID |
| `linearClientSecret` | `string` | — | **Required for OAuth.** Linear OAuth client secret |
| `projectMemoryEnabled` | `boolean` | `true` | Enable project-based memory persistence |
| `projectMemoryBasePath` | `string` | `~/clawd/projects` | Base path for project directories |

The default `agentIdentity` instructs the agent to act as a Linear workflow assistant (not a personal assistant), and lists the available Linear tools.

## Deployment Notes

### Agent Binding

By default, Linear sessions run under the `main` agent. You can isolate them with a dedicated agent binding:

```json
{
  "agents": {
    "list": [
      {
        "id": "linear",
        "name": "Linear Worker",
        "workspace": "~/clawd",
        "tools": { "allow": ["group:plugins"] }
      }
    ],
    "bindings": [
      { "channel": "linear", "agent": "linear" }
    ]
  }
}
```

### Concurrency

The default `maxConcurrent` is 4. If you expect many issues to be active simultaneously, increase it:

```json
{
  "agents": {
    "defaults": {
      "maxConcurrent": 999
    }
  }
}
```

## Troubleshooting

### "no access token" at startup

Visit `/linear-light/oauth/init` to start the OAuth flow.

### Webhook returns 401

Check that `webhookSecret` matches the signing secret in your Linear OAuth app settings.

### Completion loop spins after gateway restart

Ensure you're on a version that includes the fallback context fix ([#126](https://github.com/QiuYi111/openclaw-linear-light/pull/126)).

### Health check returns "degraded"

Check the `errors` and `warnings` fields in the `/linear-light/status` response for specific guidance.

## Development

```bash
npm install            # install dev dependencies
npm run lint           # biome check
npm run typecheck      # tsc --noEmit
npm run test           # vitest
npm run test:coverage  # vitest with coverage (threshold: 90%)
npm run check          # lint + typecheck + test
```

Zero runtime dependencies. TypeScript strict mode. ESM only. 95%+ test coverage.

## Credits

Infrastructure borrowed from:
- [openclaw-linear-plugin](https://github.com/calltelemetry/openclaw-linear-plugin) — webhook handling, Linear GraphQL API, dedup
- [cyrus](https://github.com/ceedaragents/cyrus) — webhook verification, message translation patterns

## License

MIT
