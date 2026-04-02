# CLAUDE.md — Coding Agent 约束

## 项目定位

`openclaw-linear-light` 是 OpenClaw 平台的 Linear 集成插件。
核心功能：接收 Linear webhook → 触发 agent session → 管理 issue 状态 → 完成后通知。

## 第一性原理

修改任何代码前，先回答：
1. **这个改动的目的是什么？** — 对应哪个 issue 或需求？
2. **影响范围是什么？** — 改了一行，哪些调用者受影响？
3. **是否有测试覆盖？** — 没有测试的改动不允许合并。

## 开发流程（强制）

```
1. 改代码
2. npm run lint          # biome check → 0 errors
3. npm run typecheck     # tsc --noEmit → 0 errors
4. npm run test:coverage # vitest → 全部通过 + ≥90% coverage
5. 全部通过后才允许 commit + push
```

**禁止跳过步骤 2-4。** CI 会执行相同的检查，本地先通过再推送。

## 代码规范

- **语言**: TypeScript strict mode (`tsconfig.json` 中 `strict: true`)
- **Lint**: Biome (`biome.json`) — 格式化 + lint 一体
- **模块**: ESM only (`"type": "module"`)
- **注释**: 英文注释
- **风格**: 2 space indent, no semicolons, double quotes
- **错误处理**: 外部 API 调用必须有 error handling，但不要过度防御内部代码

## 架构约束

- **入口**: `index.ts` — 注册路由、工具、lifecycle hooks
- **Webhook**: `src/webhook-handler.ts` — 签名验证 → dedup → 路由 → dispatch
- **API**: `src/api/linear-api.ts` — GraphQL client, token 管理
- **工具**: `src/utils.ts` — 共享工具函数
- **禁止引入新的运行时依赖** — 当前 0 dependencies，保持这样

## 测试规范

- 测试框架: Vitest
- 测试文件: `src/__test__/*.test.ts`
- Fixtures: `src/__test__/fixtures.ts`
- Coverage threshold: **90%** lines/branches/functions/statements
- Mock 外部 API (fetch, fs)，不要 mock 内部模块

## 提交规范

- Commit message: `type: description`（feat / fix / refactor / test / ci / docs）
- 一个 commit 一个逻辑变更
- 禁止 `--no-verify` 跳过 hooks
