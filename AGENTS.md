# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript source for the daemon/runtime.
  - `src/main.ts`: daemon entrypoint.
  - `src/runtime/`: core modules (config, DB, session manager, service orchestration).
  - `src/runtime/platform/`: Slack and Telegram integrations.
  - `src/runtime/migrations/`: database schema migrations.
- `tintin.ts`: CLI entrypoint (published as the `tintin` binary).
- `config.example.toml`: config template; local `config.toml` is gitignored.
- `setup_docs/`: Slack/Telegram setup docs.
- `dist/`: build output (generated; do not edit by hand).

## Build, Test, and Development Commands

Requires Node.js `>=20` (see `package.json` `engines`).

```bash
npm ci            # install deps (CI-style)
npm run typecheck # TypeScript checks (no emit)
npm run build     # compile to dist/
npm start         # run daemon: node dist/src/main.js
npm run migrate   # run DB migrations: node dist/src/migrate.js
```

Example local run:

```bash
npm run build
CONFIG_PATH=./config.toml node dist/tintin.js start
```

## Coding Style & Naming Conventions

- TypeScript + ESM (`"type": "module"`). Keep code strict; avoid `any` unless unavoidable.
- Match existing formatting: 2-space indentation, double quotes, semicolons.
- Naming: `camelCase` for values, `PascalCase` for types/classes, and migrations as `src/runtime/migrations/0004_short_description.ts` (increment prefix; use `snake_case`).

## Testing Guidelines

- No automated test suite is configured yet. Use `npm run typecheck` and do a quick smoke run (start the daemon and exercise a basic CLI command like `status`).
- DB/schema changes must include a new migration in `src/runtime/migrations/` and be verified via `npm run migrate`.

## Commit & Pull Request Guidelines

- Commits use short, imperative summaries (e.g., “Fix CI”, “Bump version”, “Add Playwright MCP sidecar”).
- PRs should include: what/why, steps to verify, and notes on config/migrations. For Slack/Telegram UX changes, include screenshots or message transcripts.

## Security & Configuration Tips

- Never commit secrets or runtime data: `config.toml`, `data/`, and `.codex/` are intentionally gitignored. Prefer `env:VAR` for tokens/secrets in `config.toml`.
- When adding new config fields or changing behavior, update `config.example.toml` and `README.md`.
