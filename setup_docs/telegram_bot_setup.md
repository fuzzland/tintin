# Telegram Bot Setup for Tintin

## For Experienced Users
Create a Telegram bot, create a group with Topic enabled, invite the bot to the group, set the bot as the admin of the group. All set. 


## For Non-Experienced Users

### 1) Create the bot in Telegram
1. Open Telegram, search for **BotFather**, start a chat.
2. Send `/newbot`, follow prompts, and pick a unique username ending with `bot`.
3. BotFather replies with a **HTTP API token**. Copy it; this becomes `TELEGRAM_TOKEN`.
4. (Optional but recommended for thread-based sessions) Disable privacy so the bot can see replies without @mentions:
   - Send `/setprivacy` → choose your bot → **Disable**.

### 2) Prepare secrets
Edit `config.toml` to set the bot token:
```bash
[telegram]
token = [123456:XZGEXXTbZnmKNm2xxxxxxxx]
```


If you have a second bot token to spread send load, set `additional_bot_tokens = ["<YOUR SECOND BOT TOKEN>"]`.



### 3) Setup the Group
1. Create a Group
2. Click on the title of the group, select `More` > `Manage Group`
3. Click on `Topics` > `Enable Topics`. Make sure the toggle is on. 
4. Click `Administrators` > `Add Administrator`, select the bot then click `Save`. No need to enable or disable any permission toggles. 

### 4) Limit who can talk to Tintin

Limit who can talk to the bot by setting allowlists in `[security]` (replace IDs with your own):
```toml
[security]
telegram_allow_chat_ids = [-1001234567890]   # group/supergroup/channel IDs (Telegram reports supergroups as -100<id>)
telegram_allow_user_ids = [123456789]        # optional: specific user IDs
```

Methods to obtain chat ID: https://stackoverflow.com/a/72649378

### 5) Choose how the bot receives messages
- **Polling (easy, no HTTPS needed):**
  - Set `mode = "poll"`.

- **Webhook (needs public HTTPS):**
  - Set `mode = "webhook"`.
  - Add following configs to `config.toml` under `[telegram]` block:
    ```
    public_base_url = "https://fierce-pickle-raccon.ctf.so"
    webhook_path = "/tg/webhook"
    webhook_secret_token = "env:TELEGRAM_WEBHOOK_SECRET"
    ```
  - Set `public_base_url` to your HTTPS root (e.g., `https://your-domain.com`).
  - Ensure your reverse proxy forwards `webhook_path` (default `/tg/webhook`) to the Tintin server (`[bot].host`/`[bot].port`).
    Example Nginx block: `location /tg/webhook { proxy_pass http://127.0.0.1:9393; }`


## 6) Run and verify
1. Start Tintin: `./tintin start --config config.toml`
2. Health check: `curl -f http://127.0.0.1:9393/healthz` (use your port).
3. In Telegram, send `/codex` to your bot (mention the bot if required) and follow the prompts.
4. If messages don’t arrive:
   - Polling mode: confirm `TELEGRAM_TOKEN` is correct.
   - Webhook mode: confirm your public URL is correct and reachable; check proxy routing and the secret token.
