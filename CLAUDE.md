# CLAUDE.md

## What is Paperclip?

Open-source control plane for autonomous AI companies. Not an agent framework — the operating system that orchestrates agent teams with org charts, task management, budgets, governance, and monitoring. Agents run externally and connect via API.

## Repo Map

| Path | What |
|------|------|
| `server/` | Express 5 REST API + WebSocket + orchestration |
| `ui/` | React 19 + Vite + Tailwind + shadcn/ui |
| `packages/db/` | Drizzle ORM schema & migrations (PostgreSQL) |
| `packages/shared/` | Types, constants, validators, API paths |
| `packages/adapters/` | Agent adapters (claude, codex, cursor, gemini, openclaw, etc.) |
| `packages/adapter-utils/` | Shared adapter utilities |
| `packages/plugins/` | Plugin SDK + examples |
| `cli/` | CLI for onboarding, config, client operations |
| `doc/` | Internal specs & operational docs |
| `docs/` | Public-facing API & guide docs |
| `skills/` | Skill definitions (paperclip, create-agent, create-plugin, para-memory) |
| `tests/` | Test suites |
| `evals/` | Evaluation harnesses |

## Tech Stack

- **Backend:** Express 5, TypeScript, PostgreSQL (Drizzle ORM), Zod, Pino, WebSockets
- **Frontend:** React 19, Vite, Tailwind CSS, shadcn/ui, TanStack Query, Lexical editor
- **Testing:** Vitest, Playwright (E2E)
- **Runtime:** Node.js 20+, pnpm 9+

## Dev Commands

```sh
pnpm install          # install deps
pnpm dev              # API + UI in watch mode (localhost:3100)
pnpm dev:once         # without watch
pnpm build            # build all packages
pnpm -r typecheck     # typecheck all packages
pnpm test:run         # run vitest tests
pnpm db:generate      # generate DB migrations (after schema changes)
pnpm db:migrate       # apply migrations
```

## Database

- Leave `DATABASE_URL` unset for embedded PostgreSQL (zero config, data at `~/.paperclip/instances/default/db/`)
- Schema lives in `packages/db/src/schema/*.ts`
- DB change workflow: edit schema -> export from index.ts -> `pnpm db:generate` -> `pnpm -r typecheck`

## Key Architecture Rules

1. **Company-scoped** — every entity scoped to a company, enforce boundaries in routes/services
2. **Contracts synchronized** — schema change = update db + shared + server + ui
3. **Control-plane invariants** — single-assignee tasks, atomic checkout, approval gates, budget hard-stop, activity logging
4. **No wholesale doc replacement** — prefer additive updates to strategic docs
5. **Plan docs** — `doc/plans/YYYY-MM-DD-slug.md` format

## Lockfile Policy

Do NOT commit `pnpm-lock.yaml` in PRs. CI owns it. CI regenerates on master pushes.

## PR Requirements

- Include a "thinking path" at top of PR description (see CONTRIBUTING.md)
- Include before/after screenshots for UI changes
- Run `pnpm -r typecheck && pnpm test:run && pnpm build` before claiming done

## Verification Checklist

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## API Conventions

- Base path: `/api`
- Board access = full-control operator
- Agent access = bearer API keys (hashed at rest), company-scoped
- Endpoints need: company access checks, actor permissions, activity log entries, consistent HTTP errors (400/401/403/404/409/422/500)

## Skills Reference

| Skill | When to use |
|-------|-------------|
| `/paperclip` | Interacting with Paperclip control plane API — tasks, heartbeats, approvals, delegation |
| `/design-guide` | Building or modifying UI components — design system, patterns, styling |
| `/work-task` | Full workflow: pull task, plan, enhance, implement, complete |
| `/release` | Release workflow: commit, push, PR, CI, merge, publish |
| `/enhance-plan` | Enhance implementation plans with Usable standards and best practices |
| `/devops-investigation` | Investigate service outages and infrastructure issues |
| `/git-worktrees` | Parallel development with isolated git worktrees |

## Key Docs to Read

1. `doc/GOAL.md` — vision and values
2. `doc/PRODUCT.md` — core concepts
3. `doc/SPEC-implementation.md` — V1 build contract
4. `doc/DEVELOPING.md` — dev setup & workflow
5. `doc/DATABASE.md` — database modes & config
6. `AGENTS.md` — contributor guidance & engineering rules
