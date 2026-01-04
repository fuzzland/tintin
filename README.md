# Tintin

Tintin is your girlfriend and engineer. It allows you to control Codex and other coding agents via Telegram or Slack.

## Setup

- Make sure [npm](https://dev.to/ms314006/how-to-install-npm-through-nvm-node-version-manager-5gif) and [Codex](https://github.com/openai/codex?tab=readme-ov-file#quickstart) are available, and Codex has been logged in (either via API from environment or ChatGPT UI).
- Optional (for Telegram `/cc`): install and authenticate [Claude Code](https://code.claude.com/).
- Optional (for Telegram `/cc`): add a `[claude_code]` section in `config.toml` (see `config.example.toml`).

- Run `npm i -g @fuzzland/tintin`.

- Create `config.toml` by copying [example config](https://github.com/fuzzland/tintin/blob/master/config.example.toml):

  - Set your projects. For example:
    ```
    [[projects]]
    id = "tintin"
    name = "tintin"
    path = "/home/ubuntu/tintin"
    ```
  - Optionally set `[bot].github_repos_dir` to control where `tintin new` clones git repositories. Use `github:<owner>/<repo>` when adding GitHub sources.
  - Create a [Slack bot and channel](https://github.com/fuzzland/tintin/tree/master/setup_docs/slack_bot_setup.md) or create a [Telegram bot and a group](https://github.com/fuzzland/tintin/tree/master/setup_docs/telegram_bot_setup.md)
  - Set `[telegram]` and/or `[slack]` secrets (supports `env:VAR`).
  - Optional: set `[security].*` allowlists to allow only certain users to use the bot in defined set of group chats.
  - Optional: configure `[cloud]` to enable cloud mode (GitHub App + OAuth connections, shared repos, and `tinc` CLI).

- Run `tintin start`.

Quick start (Chinese): `docs/quick-start.md`

## Useful commands

- Add a project: `tintin new "my project" <path-or-git-url> [id]` (use `github:<owner>/<repo>` for GitHub shorthand; supports `--github-dir` and `--github-token`)
- Tail logs: `tintin log`
- Stop: `tintin stop`
- Restart: `tintin restart`
- Status: `tintin status`

## Cloud mode (tinc)

Cloud mode lets users run actions via Slack/Telegram without pre-registering projects. Users connect GitHub (via a GitHub App install flow) or GitLab/local (via OAuth), share repos into a chat, and run cloud actions. The cloud server must be reachable on a public IP for the GitHub App and OAuth callbacks.

GitHub App setup: configure `[cloud.github_app]` (app_id, app_slug, private_key as base64-encoded PEM) and set the app callback URL to `${cloud.public_base_url}${cloud.oauth.callback_path}`.

To run on Modal, set `[cloud].provider = "modal"` and configure `[cloud.modal]` (token, app name, image, timeouts; defaults: `timeout_ms`/`idle_timeout_ms` = 86400000). The Modal image should include Playwright + browser and the agent binaries (`codex` and/or `claude`) or adjust `cloud.modal.codex_binary` / `cloud.modal.claude_binary` to match.

API access in cloud mode:
- Users can provide their own `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (and optional `*_BASE_URL`) via `tintin secrets`.
- If not provided, Tintin can route through the built-in metered proxy (`[cloud.proxy]`), which must be enabled and configured.

Key commands (chat):
- `connect github|gitlab|local`
- `repos`, `repo select <number>` (or `repo select playground`), `repo share <number>`
- `run <prompt>` / `status <runId>` / `pull <runId>`
- `secrets set|list|delete`

CLI (cloud binary): `tinc`
- `tinc lift` generates `tintin-setup.yml`
- `tinc pull --run <id>` fetches a diff artifact
- `tinc attach --run <id>` streams run output to your terminal
- CLI auth: in a 1:1 chat, run `tinc token` to get a token. Then set:
  ```
  export TINC_URL=http://127.0.0.1:8787
  export TINC_TOKEN=<token>
  ```

### Cloud UI

Tintin can serve a lightweight web UI for cloud runs (events, diffs, terminal playback, screenshots).

- Configure `[cloud.ui]` in `config.toml` (token secret, S3 bucket/region, signed URL TTLs). The token secret is also used to sign `tinc` CLI tokens. See `config.example.toml`.
- UI is served at `${cloud.public_base_url}${cloud.ui.path}` and links are shared in Slack/Telegram with a `?token=...` query param.
- Group chat links are scoped to a single run; private chat links can view all runs for that identity.

### Playwright MCP

Tintin can run the [Playwright MCP](./references/playwright-mcp/README.md) sidecar so Codex / Claude Code can drive a real browser.

- Configure `[playwright_mcp]` in `config.toml` (see `config.example.toml`). Defaults start `npx -y @playwright/mcp@latest` with Chrome, shared user data dir, and an auto-picked port > 10000.
- A single shared profile (`user_data_dir`) is used across sessions; set `executable_path` if Chrome is not on PATH.
- Codex / Claude Code sessions are automatically pointed at the running Playwright MCP server; every Playwright MCP tool call triggers a screenshot saved under the configured `output_dir` and posted to the chat.
- For cloud runs on Modal, you can set `playwright_mcp.provider = "browserbase"` and configure `[playwright_mcp.browserbase]` to create per-session Browserbase CDP connections.
- Hyperbrowser is also supported via `playwright_mcp.provider = "hyperbrowser"` with `[playwright_mcp.hyperbrowser]`.

## Chat flows

- Telegram: mention the bot or send `/codex` (Codex) / `/cc` (Claude Code) → choose project → prompt → session is created (topics preferred; reply-thread fallback).
- Slack: mention the bot → pick project (select) → modal for prompt (and custom path if needed) → session thread is created.
- List sessions:
  - Telegram: `/sessions` (or `/codex sessions`, `/cc sessions`, or `@bot sessions`; add `page 2` for older sessions, `active` to filter)
  - Slack: mention the bot with “sessions” (e.g. `@bot sessions`; add `page 2` or `active`)
- Messages posted into a session while it is still running are queued and automatically resumed when the current run exits.
