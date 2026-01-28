# Slack App Setup for Tintin (OAuth, Multi-Workspace)

## What you need
- A public HTTPS URL that Slack can reach (reverse proxy or tunnel like `ngrok`).
- This repo checked out with a working `config.toml`.
- Slack workspace admin access to create/install an app.

## 1) Create the Slack app
1. Go to https://api.slack.com/apps → “Create New App” → “From scratch”.
2. Name it (e.g., “Tintin”) and pick any workspace for initial setup.
3. In **Basic Information**, copy:
   - **Client ID**
   - **Client Secret**
   - **Signing Secret**

## 2) Configure OAuth & Permissions
1. In **OAuth & Permissions**:
   - Add a **Redirect URL**: `https://your-domain.com/slack/oauth_redirect`
2. Add **Bot Token Scopes** (minimum required):
   - `chat:write`
   - `conversations:write`
   - `conversations:read`
   - `users:read`
   - `reactions:write`
   - `files:write`
   - `app_mentions:read`
   - `im:read`
3. Save changes.

## 3) Enable App Distribution (Public Install)
1. In **Manage Distribution**, enable public distribution.
2. Use this install URL for users/admins:
   - `https://your-domain.com/slack/install`

## 4) Turn on Event Subscriptions
1. In **Event Subscriptions**, toggle **Enable Events** on.
2. Set **Request URL** to `https://your-domain.com/slack/events`.
3. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.im`
   - `message.channels` (if you want channel usage)
   - `message.groups` (if you want private channels)
4. Save.

## 5) Turn on Interactivity
1. In **Interactivity & Shortcuts**, toggle **Interactivity** on.
2. Set **Request URL** to `https://your-domain.com/slack/interactions`.
3. Save.

## 6) Wire secrets into Tintin
Export the secrets in your shell (or your process manager):
```bash
export SLACK_CLIENT_ID="123.456"
export SLACK_CLIENT_SECRET="xxxx"
export SLACK_STATE_SECRET="a-strong-random-secret"
export SLACK_SIGNING_SECRET="your_slack_signing_secret"
```

Update `config.toml`:
```toml
[slack]
client_id = "env:SLACK_CLIENT_ID"
client_secret = "env:SLACK_CLIENT_SECRET"
state_secret = "env:SLACK_STATE_SECRET"
public_base_url = "https://your-domain.com"

signing_secret = "env:SLACK_SIGNING_SECRET"
scopes = [
  "chat:write",
  "conversations:write",
  "conversations:read",
  "users:read",
  "reactions:write",
  "files:write",
  "app_mentions:read",
  "im:read",
]
# user_scopes = []

events_path = "/slack/events"
interactions_path = "/slack/interactions"

session_mode = "thread"
max_chars = 3000
rate_limit_msgs_per_sec = 1.0
message_queue_interval_ms = 1000
```

Optional allowlists in `[security]`:
```toml
[security]
slack_allow_workspace_ids = ["T01234567"]
slack_allow_channel_ids   = ["C01234567"]
slack_allow_user_ids      = ["U01234567"]
```

## 7) Install and verify
1. Start Tintin: `./tintin start --config config.toml`
2. Visit the install URL: `https://your-domain.com/slack/install`
3. Install into a workspace as admin.
4. DM the bot or mention it in a channel.
5. Verify that events and interactivity succeed.

Note: Each workspace must install the app via OAuth. There is no static bot token in this flow.
