# Eval: Token Rotation Split-Brain Fix (2026-05-17)

## Change Summary

| File | Change | Scope |
|------|--------|-------|
| `src/standalone/index.ts` L77-78 | Prefer `config.linear.clientId` over `process.env.LINEAR_CLIENT_ID` | standalone entry only |
| `~/.hermes/scripts/linear-gateway-watchdog.py` L91,95 | Read refreshToken from `LINEAR_TOKEN` (gateway token file) instead of `OPENCLAW_TOKEN` (OpenClaw plugin file) | watchdog cron only |
| `maintenance/debug/2026-05-17-token-rotation-splitbrain/record.md` | Debug record (new) | docs |
| `~/.linear-gateway/token.json` | Re-authorized OAuth token (operational data, not in git) | ops |
| `~/.openclaw/plugins/linear-light/token.json` | Synced same token (operational data, not in git) | ops |

## Product Eval

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Root cause identified | PASS | Token rotation split-brain: gateway writes refreshToken to `~/.linear-gateway/token.json`, watchdog reads from `~/.openclaw/plugins/linear-light/token.json`. Linear rotates refreshTokens on each use — two files with different tokens → both revoked. |
| Fix addresses root cause | PASS | Watchdog now reads from same file as gateway (`LINEAR_TOKEN` = `~/.linear-gateway/token.json`). Single source of truth for refreshToken. |
| config.linear.clientId fallback | PASS | `index.ts` now prefers `config.linear.clientId` before falling back to env var. Matches how `LinearAgentApi` consumes credentials — consistent with `config.json` being the primary config source. |
| No new dependencies | PASS | Zero new imports or runtime deps. |
| Edge case: missing config.linear fields | PASS | Uses `||` (OR) — falls back to `process.env` if config field is falsy. Backward compatible. |

## Harness Eval

| Gate | Status | Evidence |
|------|--------|----------|
| Blast radius classified | leaf | Only affects standalone entry point init + watchdog script. No core webhook/API logic touched. |
| Related tests pass | PASS | `linear-api.test.ts` (39), `watchdog.test.ts` (8), `config-validation.test.ts` (10) — all 57 pass. Run: `npx vitest run src/__test__/linear-api.test.ts src/__test__/watchdog.test.ts src/__test__/config-validation.test.ts` |
| Lint — our changes clean | PASS | Biome errors are all pre-existing (`index.ts` noExplicitAny, `webhook-handler.ts` unused imports). Our 2-line diff in `standalone/index.ts` produces no new lint errors. |
| Typecheck — our changes clean | PASS | `tsc --noEmit` errors are pre-existing (`webhook-handler.ts` TS2305, TS2339). Our change to `standalone/index.ts` adds `config.linear.clientId || process.env.LINEAR_CLIENT_ID` — both are `string | undefined`, type-safe. |
| Pre-existing test failures | NOTED | 8 failures in `hermes-adapter.test.ts` (3) + `webhook-handler.test.ts` (5) — all pre-existing, unrelated to this change. |
| Integration test | PASS | PER-108: webhook → AgentSessionEvent → agentActivityCreate (no more 403) → dispatch to Hermes accepted → state update to In Progress. All within 13s end-to-end. |

## Verification Evidence (fresh, this session)

```
$ npx vitest run src/__test__/linear-api.test.ts src/__test__/watchdog.test.ts src/__test__/config-validation.test.ts
 ✓ src/__test__/config-validation.test.ts (10 tests) 4ms
 ✓ src/__test__/watchdog.test.ts (8 tests) 25ms
 ✓ src/__test__/linear-api.test.ts (39 tests) 24ms
 Test Files  3 passed (3)
 Tests  57 passed (57)
```

```
$ pm2 logs linear-gateway --lines 10 --nostream
13:10:55  Hermes adapter: dispatching for PER-108
13:10:55  Hermes adapter: accepted for PER-108
13:10:55  emitted initial activity for PER-108    ← agentActivityCreate OK (was 403 with API key)
13:11:07  set PER-108 to In Progress
```

## Verdict: READY TO COMMIT

Two logical commits recommended:

1. `fix: prefer config.linear credentials over env vars in standalone entry` — `src/standalone/index.ts`
2. `docs: token rotation split-brain debug record` — `maintenance/debug/2026-05-17-token-rotation-splitbrain/record.md`

Watchdog script (`~/.hermes/scripts/linear-gateway-watchdog.py`) is not in the project repo — managed independently.
