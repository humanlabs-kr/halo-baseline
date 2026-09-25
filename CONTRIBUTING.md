# Contributing

## Setup

See [README.md](./README.md#quick-start). You need Node 22+, pnpm 9.15+ and a
PostgreSQL database.

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
```

CI runs exactly these three. A commit also triggers a pre-commit hook that runs
ESLint on staged files and blocks the commit if a Drizzle schema change is
missing its migration.

## Conventions

[AGENTS.md](./AGENTS.md) is the short version of everything we care about:
response shapes, auth, query rules, naming, and the reasons behind them. It is
worth reading once in full.

Two things reviewers will always ask about:

- **`as any` in `apps/api`.** The route pattern is designed so it is never
  needed. If you hit a case where it seems to be, say so in the PR rather than
  casting — it usually means the response schema and the handler disagree.
- **Copy-paste between apps.** If the same code needs to exist twice, it belongs
  in `packages/`.

## Commits

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`,
`test:`). Scope with the workspace where it helps: `feat(api): …`.

## Reporting a security issue

Do not open a public issue. Email security@humanlabs.world.
