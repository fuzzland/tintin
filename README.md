# Tintin

Tintin is your girlfriend and engineer. It allows you to control Codex and other coding agents (WIP) via Telegram or Slack. 

## Setup

- Make sure [npm](https://dev.to/ms314006/how-to-install-npm-through-nvm-node-version-manager-5gif) and [Codex](https://github.com/openai/codex?tab=readme-ov-file#quickstart) is available, and Codex has been logged in (either via API from environment or ChatGPT UI). 

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

- Run `tintin start`. 


## Useful commands
- Add a project: `tintin new "my project" <path-or-git-url> [id]` (use `github:<owner>/<repo>` for GitHub shorthand; supports `--github-dir` and `--github-token`)
- Tail logs: `tintin log`
- Stop: `tintin stop`
- Status: `tintin status`

## Chat flows

- Telegram: mention the bot or send `/codex` → choose project → prompt → session is created (topics preferred; reply-thread fallback).
- Slack: mention the bot → pick project (select) → modal for prompt (and custom path if needed) → session thread is created.
- List sessions:
  - Telegram: `/sessions` (or `/codex sessions`, or `@bot sessions`; add `page 2` for older sessions, `active` to filter)
  - Slack: mention the bot with “sessions” (e.g. `@bot sessions`; add `page 2` or `active`)
- Messages posted into a session while Codex is still running are queued and automatically resumed when the current run exits.
