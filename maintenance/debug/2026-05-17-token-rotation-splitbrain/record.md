# Debug Record: Token Rotation Split-Brain

- **ID**: 2026-05-17-token-rotation-splitbrain
- **Status**: diagnosed
- **Risk**: leaf (single-file fix in watchdog script)
- **Started**: 2026-05-17
- **Component**: token persistence (gateway + watchdog)

## Symptom

Linear gateway returns 401 for all API calls since ~2026-05-09. OAuth refresh tokens are permanently revoked (`invalid_grant`). Gateway process is alive, Funnel is up, webhooks arrive but all Linear API operations fail.

## Expected Behavior

Gateway auto-refresh should rotate tokens transparently. Watchdog should only fire when gateway's own refresh fails.

## Actual Behavior

Two independent refresh mechanisms read from different token files, creating a split-brain under Linear's refresh token rotation policy.

## Reproduction

Consistent — all API calls return 401 since token expiry. Deterministic.

## Evidence

### Token file divergence

| File | Last modified | expiresAt | refreshToken suffix |
|------|--------------|-----------|-------------------|
| `~/.linear-gateway/token.json` | 2026-05-08 12:20 | 2026-05-09 04:20 | `...a0c3b75e` |
| `~/.openclaw/plugins/linear-light/token.json` | 2026-04-28 09:38 | 2026-04-29 01:38 | `...2e42b12c` |

Both files hold DIFFERENT refreshTokens. Both are now revoked.

### Log timeline

- `2026-04-17 07:33` — First `401` (no refresh attempted — pre-`core/` refactor code)
- `2026-04-18 09:31` — First `401 (after refresh)` — gateway tried but failed
- `2026-04-28 09:34` — Last 401 event before quiet period (log 8 → 9 gap)
- `2026-05-08 12:20` — GW token file modified (last successful auto-refresh)
- `2026-05-09 04:20` — GW token expires
- `2026-05-10 15:16` — Gateway process restarted (current PID)
- `2026-05-17` — Now: both tokens expired, both refreshTokens revoked

### Refresh attempt result

```
HTTP 400: {"error":"invalid_grant","error_description":"Refresh token revoked"}
```

## Root Cause

**Split-brain token rotation between gateway auto-refresh and watchdog cron.**

Two processes can refresh tokens, but they read from different files:

1. **Gateway auto-refresh** (`core/linear-client.ts` → `FileTokenStore`):
   - Reads from: `~/.linear-gateway/token.json`
   - Writes to: `~/.linear-gateway/token.json` ONLY
   - Does NOT update `~/.openclaw/plugins/linear-light/token.json`

2. **Watchdog cron** (`~/.hermes/scripts/linear-gateway-watchdog.py`):
   - Reads refreshToken from: `~/.openclaw/plugins/linear-light/token.json` (line 91: `source_token_path = OPENCLAW_TOKEN`)
   - Writes to: BOTH files on success

Linear uses **refresh token rotation**: each successful refresh returns a new refreshToken and revokes the old one.

**The race**: When gateway refreshes token, it rotates the refreshToken and writes it to the GW file. The OC file still holds the old (now revoked) refreshToken. When watchdog later reads from the OC file and attempts refresh, it either:
- Fails with `invalid_grant` (stale token)
- Succeeds but invalidates the GW file's refreshToken (rotation)

After enough round-trips, both files hold invalid refreshTokens → permanent 401 with no recovery path.

### Why the gateway's own auto-refresh eventually fails

The gateway only refreshes on-demand (when a GraphQL call is made). If no webhooks arrive during the token's lifetime, the token expires silently. On next webhook, the gateway tries to refresh using its stored refreshToken. But if the watchdog already consumed and rotated it away, the gateway's refreshToken is revoked too.

## Hypotheses Tried

| # | Hypothesis | Result |
|---|-----------|--------|
| 1 | `persistToken()` writes to wrong file (oauth-store instead of tokenStore) | DISPROVED — deployed dist uses `core/linear-client.js` which correctly writes to `tokenStore` |
| 2 | Token file divergence from dual-write | CONFIRMED — two files, two readers, rotation semantics |

## Patch Plan

### Fix 1: Watchdog reads from same file as gateway (leaf risk)

Change watchdog's `refresh_token()` to read from `LINEAR_TOKEN` (`~/.linear-gateway/token.json`) instead of `OPENCLAW_TOKEN`.

```python
# Before (line 91):
source_token_path = OPENCLAW_TOKEN

# After:
source_token_path = LINEAR_TOKEN
```

This eliminates the split-brain: both gateway and watchdog read from the same canonical file.

### Fix 2 (defense-in-depth): Remove `~/.openclaw/plugins/linear-light/token.json` from the equation

The OC token file is a legacy artifact from the old `oauth-store.ts` code path. The standalone gateway never reads it. Remove it from watchdog's path entirely and don't write back to it.

### Fix 3 (optional): Gateway also writes to OC file for backward compat

If any other tool reads from the OC file, gateway should write to both. But since no other tool does, this is unnecessary complexity.

## Regression Prevention

1. Watchdog reads from single canonical path (`~/.linear-gateway/token.json`)
2. Watchdog still writes to both (harmless, keeps OC file as backup)
3. Token rotation is now single-writer: only gateway or watchdog, never both independently
