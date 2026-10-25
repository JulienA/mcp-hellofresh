# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com). Claude and ChatGPT each connect as themselves. On `/authorize`, that person signs in to their own HelloFresh account. Tools then call HelloFresh's `/gw` API for that account only.

This API is unofficial and can change. A bot-protection block is not a wrong password.

## Features

| Tool | Description |
|------|-------------|
| `auth_status` | Email, country, whether the access token is still valid, and when it was saved. Never returns tokens. |
| `login` | Local stdio: open a headed window so you can finish **Continue with Google**, then save `apiV2Auth`. HTTP: tells you to disconnect and reconnect the connector. |
| `logout` | Delete the saved tokens for this account only. |
| `get_menu` | Menu for an upcoming week |
| `get_recipe_details` | Recipe payload from `/gw/recipes` |
| `select_meals` | Save a meal selection for a week |
| `skip_week` | Skip a delivery week |
| `get_delivery_schedule` | Upcoming deliveries |
| `modify_delivery` | Move one delivery to another date HelloFresh offers |
| `get_preferences` | Food profile |
| `update_preferences` | Update the food profile |
| `get_subscription` | Plan size and next delivery |
| `modify_subscription` | Change meals or servings. Delivery frequency is left unchanged. |
| `get_past_orders` | Past deliveries |
| `rate_recipe` | Not available through this API. The tool says so. |

## Requirements

- Node.js 20+
- A HelloFresh account in a supported country (`us`, `ca`, `uk`, `au`, `nz`, `de`, `at`, `ch`, `nl`, `be`, `lu`, `fr`, `ie`, `dk`, `no`, `se`)

Playwright is optional. It is used only by local `npm run login` (and the stdio `login` tool) so you can finish Google sign-in in a window on your machine. The HTTP server does not launch a browser.

## Installation

```bash
npm install @striderlabs/mcp-hellofresh
```

For local Google sign-in, also install Chromium:

```bash
npx playwright install chromium
```

## Remote HTTP (claude.ai and ChatGPT)

```bash
npx mcp-hellofresh --http
```

Connector URL: `https://<your-host>/mcp`

HelloFresh does not offer third-party OAuth. Claude and ChatGPT complete OAuth against this server (dynamic client registration, PKCE, refresh). The HelloFresh sign-in happens in the browser, on `/authorize`, and only for that person:

1. Choose the country.
2. Either enter the HelloFresh email and password (not a Google, Apple, or Facebook password), or sign in on the HelloFresh website yourself — **Continue with Google** included — and paste the `apiV2Auth` value from that browser.
3. The server keeps the access token and refresh token, checks `GET /gw/api/customers/me/subscriptions`, and discards the password and the raw paste.

The same person connecting from Claude and from ChatGPT lands on the same account. Tokens live in `users/<userId>/tokens.json` (mode `0600`) next to the OAuth store. The password is never stored. When the refresh token is rejected, disconnect the connector and connect it again. There is no shared owner secret and no static bearer token.

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `PUBLIC_BASE_URL` | yes off localhost | Public origin, e.g. `https://hf-mcp.example.com` (no path) |
| `HOST` | no | Bind address (default `127.0.0.1`; Docker uses `0.0.0.0`) |
| `PORT` | no | Bind port (default `8080`) |
| `MCP_HTTP` | no | `1` / `true` enables HTTP without `--http` |
| `MCP_OAUTH_STORE_PATH` | no | OAuth clients and hashed tokens (file mode `0600`) |
| `MCP_USERS_DIR` | no | Per-account token directory (default: `users` next to the OAuth store) |
| `MCP_OAUTH_REDIRECT_HOSTS` | no | Comma-separated redirect hosts (default `claude.ai,claude.com,chatgpt.com`) |
| `MCP_OAUTH_ALLOW_LOOPBACK` | no | Set `0` to refuse `localhost` / `127.0.0.1` redirect URIs |
| `MCP_AUTHORIZE_MAX_ATTEMPTS` | no | Authorize attempts per IP and per email (default `10`) |
| `MCP_AUTHORIZE_WINDOW_MS` | no | Rate-limit window in ms (default `900000`) |

Endpoints: `POST /mcp`, `GET /healthz`, and OAuth (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`). Redirect URIs are allowlisted.

**claude.ai:** Settings → Connectors → custom connector → `https://<your-host>/mcp`.  
**ChatGPT:** Connectors → MCP connector with the same URL.

### Docker

The image is Node only. It does not include Playwright or a virtual display. Mount a volume so OAuth state and account tokens survive restarts:

```bash
docker build -t mcp-hellofresh .
docker run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL='https://hf-mcp.example.com' \
  -v /var/lib/mcp-hellofresh:/data \
  mcp-hellofresh
```

`/data/oauth-store.json` holds OAuth clients and hashed tokens. `/data/users` holds one HelloFresh token file per account.

## Local stdio (Claude Desktop / Claude Code)

One person, one process.

```json
{
  "mcpServers": {
    "hellofresh": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-hellofresh"],
      "env": {
        "HELLOFRESH_COUNTRY": "fr"
      }
    }
  }
}
```

Password accounts can set `HELLOFRESH_EMAIL` and `HELLOFRESH_PASSWORD`. Those are sent once to `POST /gw/login` and are not written to disk. If the refresh token later dies, the process may sign in again with those env vars.

Google, Apple, or Facebook accounts: on a machine with a display, run `npm run login` (or the `login` tool). Finish **Continue with Google** in the window. The command reads `apiV2Auth` and saves tokens to `HELLOFRESH_ACCOUNT_PATH` or `~/.config/mcp-hellofresh/account.json` (mode `0600`). Do not type a Google password into the chat, the terminal, or an MCP prompt.

```bash
claude mcp add hellofresh -- npx -y @striderlabs/mcp-hellofresh
```

## Example prompts

- "Am I connected to HelloFresh, and in which country?"
- "What meals are available this week?"
- "Select the chicken tacos for week 2026-W44"
- "Skip my delivery for week 2026-W45"
- "Move that delivery to next Thursday if HelloFresh offers it"
- "How many meals per week am I subscribed to? Change it to 3"

## Tool reference

`auth_status` takes no arguments. It returns `email`, `country`, `accessTokenValid`, `savedAt`, and `reconnectRequired`.

`login` takes no arguments and never accepts a password. Over HTTP it tells you to disconnect and reconnect the connector.

`logout` deletes only the account linked to this connection.

`get_menu`: `week_offset` optional, 0–4.

`get_recipe_details`: `recipe_id` required.

`select_meals`: `week_id` required, `meals` required (`recipe_id`, optional `servings`).

`skip_week`: `week_id` required.

`modify_delivery`: `week_id` and `new_date` (`YYYY-MM-DD`) required. The date must match a HelloFresh delivery option.

`update_preferences`: optional `vegetarian`, `family_friendly`, `dietary_preferences`, `allergens`, `cuisine_preferences`.

`modify_subscription`: optional `meals_per_week` (2–5), `servings_per_meal` (2–4), `frequency` (`weekly` or `biweekly`). Frequency is not sent to HelloFresh; the result says it was left unchanged.

`get_past_orders`: optional `limit` (1–50, default 10).

`rate_recipe`: kept so older clients still see the tool. It returns an error. Rate the recipe on the HelloFresh website.

## Security

- Never store or automate a Google, Apple, or Facebook password. The authorize page has no field for one.
- A HelloFresh password is used only for that `/gw/login` request. It is not stored, logged, or returned to the model.
- Account files and the OAuth store are mode `0600`. OAuth access and refresh tokens are stored hashed.
- A token issued before accounts were linked (no `userId`) is rejected.
- `logout` removes one account. It does not sign you out of Google.
- Redirect URIs are allowlisted. The public URL must be HTTPS except on localhost.
- This does not bypass bot protection. If HelloFresh or Cloudflare blocks the call, the error says it is not a wrong password.

## License

MIT
