---
name: linear-workflow
description: Manage Linear issues — view, update status, search, and post comments. Used when working on Linear tasks triggered via webhook.
version: 1.0.0
author: openclaw-linear-light
license: MIT
metadata:
  hermes:
    tags: [linear, project-management, workflow, issue-tracking]
    related_skills: []
platforms: [macos, linux]
requires_toolsets: [terminal, file]
---

# Linear Workflow Skill

You are working on a Linear issue triggered by a webhook. This skill provides the tools and context you need.

## Environment

The Linear API token is available as:

```bash
LINEAR_API_TOKEN=$(grep "^LINEAR_API_TOKEN=" ~/.hermes/.env | head -1 | cut -d= -f2-)
```

If not found there, check:

```bash
# Fallback: read from OpenClaw plugin config
LINEAR_API_TOKEN=$(python3 -c "
import json, os
cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(cfg_path) as f:
    cfg = json.load(f)
plugins = cfg.get('plugins', {})
entries = plugins.get('entries', plugins.get('linear-light', {}))
ll = entries.get('linear-light', entries) if isinstance(entries, dict) else {}
c = ll.get('config', {})
token = c.get('accessToken', '')
if not token:
    # Try reading from Cyrus config
    cyrus_path = os.path.expanduser('~/.cyrus/config.json')
    if os.path.exists(cyrus_path):
        with open(cyrus_path) as f2:
            cyrus = json.load(f2)
        token = cyrus.get('tokens', {}).get('linear', {}).get('access_token', '')
print(token)
")
```

The Linear API endpoint is `https://api.linear.app/graphql`.

## Core API Functions

### GraphQL Request Helper

```bash
linear_gql() {
  local query="$1"
  local vars="${2:-{}}"
  curl -s -X POST https://api.linear.app/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LINEAR_API_TOKEN" \
    -d "{\"query\": $(echo "$query" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'), \"variables\": $vars}"
}
```

### Get Issue Details

```bash
linear_gql 'query($id: ID!) {
  issue(id: $id) {
    id identifier title description state { name } url
    assignee { name } project { id name }
    comments { nodes { body user { name } createdAt } }
    labels { nodes { name } }
  }
}' "{\"id\": \"$ISSUE_ID\"}"
```

### Update Issue Status

```bash
# First, find the state ID for the target status name
linear_gql 'query($teamId: String!, $name: String!) {
  workflowStates(filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}' "{\"teamId\": \"$TEAM_ID\", \"name\": \"$STATUS_NAME\"}"

# Then update (use the state ID from above)
linear_gql 'mutation($id: ID!, $stateId: String!) {
  issueUpdate(input: { id: $id, stateId: $stateId }) {
    issue { id state { name } }
  }
}' "{\"id\": \"$ISSUE_ID\", \"stateId\": \"$STATE_ID\"}"
```

### Search Issues

```bash
linear_gql 'query($query: String!, $first: Int) {
  issueSearch(query: $query, first: $first) {
    nodes { id identifier title state { name } url }
  }
}' "{\"query\": \"$SEARCH_QUERY\", \"first\": 20}"
```

### Create Comment (Reply to Issue)

**This is how you reply to Linear issues. Use this after completing your work.**

```bash
linear_gql 'mutation($issueId: ID!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}' "{\"issueId\": \"$ISSUE_ID\", \"body\": $(python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' <<< "$YOUR_REPLY")}"
```

### Emit Activity (typing indicator / initial response)

```bash
# Only if AGENT_SESSION_ID is available in the webhook payload
linear_gql 'mutation($agentSessionId: ID!, $body: String!) {
  agentSessionActivityCreate(input: {
    agentSessionId: $agentSessionId,
    type: response,
    body: $body
  }) {
    success
  }
}' "{\"agentSessionId\": \"$AGENT_SESSION_ID\", \"body\": \"Working on $ISSUE_IDENTIFIER...\"}"
```

## Workflow

When you receive a Linear webhook trigger, the payload contains:

- `_linear_issue_id` — Linear issue UUID (use for API calls)
- `_linear_identifier` — Issue identifier (e.g. "ENG-42")
- `_linear_title` — Issue title
- `_linear_url` — Issue URL
- `prompt` — The full formatted prompt with issue description, user comments, and project context

### Step-by-step

1. **Read the prompt** — It contains the issue description, user comments, and project context
2. **Read project files** — The prompt tells you where project files are (e.g. `~/clawd/projects/<project-name>/`)
   - Read `AGENTS.md`, `Context.md`, `README.md` for project context
3. **Do the work** — Implement, investigate, fix, or whatever the issue requires
4. **Update project files** — Update `Context.md` with your findings and progress
5. **Reply on Linear** — Post a comment summarizing what you did using `commentCreate`
6. **Update status** (optional) — If the work is complete, update the issue status using `issueUpdate`

### Project Memory

Project files are stored at `~/clawd/projects/<project-name>-<hash>/`. The prompt includes the exact path.

When you make progress, update these files:

- `Context.md` — Current state, findings, architecture decisions
- `README.md` — Progress and next steps (if significant)

After updating, commit:

```bash
cd ~/clawd/projects/<project-name>-<hash>
git add -A && git commit -m "update: <brief summary>"
```

### Replying to Linear

When posting a comment, format it clearly:

```
**Summary:** Brief description of what was done

**Details:**
- Point 1
- Point 2

**Next steps:**
- [ ] Remaining item 1
- [ ] Remaining item 2
```

Keep replies focused and actionable. The user will see this in Linear.

## Important Rules

1. **Always reply on Linear** after completing work — use `commentCreate` to post your response
2. **Don't modify issue status** unless the user explicitly asks you to (e.g. mark as Done)
3. **Read project files first** before starting work — they contain context from previous sessions
4. **Update project files** after making progress — this is how continuity works across sessions
5. **Use the exact issue ID** from the webhook payload (`_linear_issue_id`) for all API calls
