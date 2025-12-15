# Slack Bot Setup for Tintin

## What you need
- A public HTTPS URL that Slack can reach (use a reverse proxy or a tunnel like `ngrok` if running locally).
- This repo checked out with a working `config.toml`.
- Slack workspace admin access to create/install an app.

## 1) Create the Slack app
1. Go to https://api.slack.com/apps → “Create New App” → “From scratch”.
2. Name it (e.g., “Tintin”) and pick the target workspace.
3. In **Basic Information**, note the **Signing Secret** (you’ll paste it into `SLACK_SIGNING_SECRET` later).

## 2) Add bot token scopes (OAuth & Permissions → Bot Token Scopes)
Add these scopes so Tintin can read mentions/messages and reply:
- `app_mentions:read` (catch @mentions to start a session)
- `channels:history` and `groups:history` (read follow-ups in public/private channels)
- `im:history` and `mpim:history` (optional; needed if you want DMs/group DMs)
- `chat:write` (send/ephemeral messages, update messages)
- `chat:write.public` (post in channels where the bot isn’t a member yet)
- `commands` (lets Slack hand over `trigger_id` so modals work)

Save changes, then click **Install to Workspace** (or **Reinstall**). After install, copy the **Bot User OAuth Token** (starts with `xoxb-`); this becomes `SLACK_BOT_TOKEN`.

## 3) Turn on Events API
1. In **Event Subscriptions**, toggle **Enable Events** on.
2. Set **Request URL** to your public URL plus the events path (default `/slack/events`). Example: `https://your-domain.com/slack/events`.
   - The URL must respond with HTTP 200 during Slack’s verification; Tintin will do this once it’s running.
3. Under **Subscribe to bot events**, add:
   - `app_mention` (to start the wizard when mentioned)
   - `message.channels`, `message.groups` (let Tintin see follow-up messages in threads)
   - Add `message.im` / `message.mpim` too if you want DMs/group DMs.
4. Save.

## 4) Turn on Interactivity
1. In **Interactivity & Shortcuts**, toggle **Interactivity** on.
2. Set the **Request URL** to your public URL plus the interactions path (default `/slack/interactions`).
3. Save.

## 5) Wire the secrets into Tintin
Export the secrets in your shell (or place them in your process manager):
```bash
export SLACK_BOT_TOKEN="xoxb-xxxxxxxx"
export SLACK_SIGNING_SECRET="your_slack_signing_secret"
```

Add a `[slack]` section to `config.toml` (values can use `env:` to read the exports):
```toml
[slack]
bot_token = "env:SLACK_BOT_TOKEN"
signing_secret = "env:SLACK_SIGNING_SECRET"
events_path = "/slack/events"
interactions_path = "/slack/interactions"
session_mode = "thread"      # "thread" (recommended) keeps each session in a thread
max_chars = 3000
rate_limit_msgs_per_sec = 1.0
```

If you want to lock down who can use the bot, set allowlists in `[security]`:
```toml
[security]
slack_allow_workspace_ids = ["T01234567"]  # optional
slack_allow_channel_ids   = ["C01234567"]  # optional
slack_allow_user_ids      = ["U01234567"]  # optional
```

## 6) Expose Tintin to Slack
- Make sure the host/port in `[bot]` (e.g., `host = "0.0.0.0", port = 9393`) is reachable.
- Reverse proxy your public URL to the Tintin HTTP server. Example Nginx location blocks:
  ```
  location /slack/events { proxy_pass http://127.0.0.1:9393; }
  location /slack/interactions { proxy_pass http://127.0.0.1:9393; }
  ```
- If developing locally, run `ngrok http 9393` and use the provided HTTPS URL.

## 7) Run and verify
1. Start Tintin: `./tintin start --config config.toml`
2. Check health: `curl -f http://127.0.0.1:9393/healthz` (or the port you set).
3. In Slack, add the bot to a channel. Mention it (`@yourbot`) and follow the prompts. Replies will stay in the thread when `session_mode = "thread"`.
4. If buttons/modals fail, confirm the interactivity URL matches `interactions_path` and that `SLACK_SIGNING_SECRET` is correct.

