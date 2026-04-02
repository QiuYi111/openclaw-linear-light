# Contributing to openclaw-linear-light

感谢你的贡献！请遵循以下规范。

## 开发环境

- Node.js >= 22
- TypeScript 5.9+
- 包管理器: npm

## 提交前检查（必须全部通过）

```bash
npm run lint          # Biome lint + format check
npm run typecheck     # TypeScript 编译检查
npm run test:coverage # 测试 + 90% coverage gate
```

也可以一键运行：

```bash
npm run check
```

**任何检查不通过，禁止提交。** CI 会执行相同的检查。

## 代码规范

- TypeScript strict mode
- ESM (`import`/`export`，不用 `require`)
- 2 space indent, no semicolons, double quotes
- 英文注释
- 零运行时依赖 — 新增依赖需说明理由

## 测试规范

- 新功能必须带测试
- Bug fix 必须带回归测试
- Coverage threshold: 90% (lines/branches/functions/statements)
- Mock 外部 API，不 mock 内部模块
- 测试文件放在 `src/__test__/`

## Commit 规范

格式: `type: description`

类型:
- `feat:` 新功能
- `fix:` 修复
- `refactor:` 重构
- `test:` 测试
- `ci:` CI/CD
- `docs:` 文档

示例:
```
feat: add concurrent run guard for webhook handler
fix: use refreshToken presence for Bearer prefix decision
test: add coverage for dedup and signature verification
```

## PR 规范

1. 从 `main` 创建 feature 分支
2. 确保所有 CI checks 通过
3. PR 描述说明：改了什么、为什么改、怎么测试的
4. 一个 PR 解决一个 issue / 一个逻辑变更

## 第一性原理

动手前先想清楚：
1. **为什么改？** — 对应哪个问题或需求
2. **影响范围？** — 谁调用了被改的代码
3. **测试覆盖？** — 怎么验证改对了
