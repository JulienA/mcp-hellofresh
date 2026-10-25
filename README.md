# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com). One HTTP server stores many HelloFresh accounts. Each connector signs in on `/authorize` to its own account. Tools call HelloFresh's `/gw` API for that account only.

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

One process stores many HelloFresh accounts. The account id is the SHA-256 of the country code, a newline, and the trimmed lowercased email. The same country and email from Claude and from ChatGPT share `users/<userId>/tokens.json` (mode `0600`) in the users directory. Another country is another account.

HelloFresh does not offer third-party OAuth. Claude and ChatGPT complete OAuth against this server (dynamic client registration, PKCE, refresh). The HelloFresh sign-in happens in the browser, on `/authorize`, and only for that person:

1. Choose the country.
2. Either enter the HelloFresh email and password (not a Google, Apple, or Facebook password), or sign in on the HelloFresh website yourself — **Continue with Google** included — and paste the `apiV2Auth` value from that browser.
3. The server keeps the access token and refresh token, checks `GET /gw/api/customers/me/subscriptions`, and discards the password and the raw paste.

The password is never stored. HelloFresh access tokens refresh from the saved refresh token. When HelloFresh rejects the refresh, disconnect the connector and connect it again.

Anyone who can finish OAuth against this server can store their HelloFresh tokens on it. Default redirect hosts are `claude.ai`, `claude.com`, and `chatgpt.com`. Loopback redirects stay allowed unless `MCP_OAUTH_ALLOW_LOOPBACK=0`. Publish the hostname only when that is intended.

MCP access tokens last one hour (`ACCESS_TOKEN_TTL_SEC`). Refresh tokens last 30 days (`REFRESH_TOKEN_TTL_SEC`) and rotate on use. Both are stored hashed and carry the HelloFresh account id.

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `PUBLIC_BASE_URL` | yes off localhost | Public HTTPS origin, e.g. `https://hf-mcp.example.com` (no path) |
| `HOST` | no | Bind address (default `127.0.0.1`; Docker uses `0.0.0.0`) |
| `PORT` | no | Bind port (default `8080`) |
| `MCP_HTTP` | no | `1`, `true`, or `yes` enables HTTP without `--http` |
| `MCP_OAUTH_STORE_PATH` | no | OAuth clients and hashed tokens (file mode `0600`). Default `~/.config/mcp-hellofresh/oauth-store.json`, or `%APPDATA%\mcp-hellofresh\oauth-store.json` on Windows. `XDG_CONFIG_HOME` is honored. |
| `MCP_USERS_DIR` | no | Per-account token directory. Default is the `users` directory next to the OAuth store. |
| `MCP_OAUTH_REDIRECT_HOSTS` | no | Comma-separated redirect hosts (default `claude.ai,claude.com,chatgpt.com`) |
| `MCP_OAUTH_ALLOW_LOOPBACK` | no | Set `0` to refuse loopback redirect URIs (`localhost`, `127.0.0.1`, `::1`) |
| `MCP_AUTHORIZE_MAX_ATTEMPTS` | no | Authorize attempts in the window (default `10`) |
| `MCP_AUTHORIZE_WINDOW_MS` | no | Rate-limit window in ms (default `900000`, 15 minutes) |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, or `error`. JSON lines on stderr. `/healthz` is `debug`. |

The default is 10 attempts per 900000 ms (15 minutes). The key is the first `X-Forwarded-For` entry, otherwise `cf-connecting-ip`, otherwise one shared bucket named `local`. Password sign-in is also counted per email. A pasted `apiV2Auth` is counted only on that header key. The TCP peer address is not the key.

JSON logs go to stderr (`docker compose logs`). Each line has `ts`, `level`, and `msg` (`http.request`, `oauth.authorize`, `oauth.token`, `mcp.tool`, `hellofresh.request`). They include method, path, status, duration, OAuth outcome, tool name, and a truncated account id. They do not include passwords, tokens, emails, or `Authorization` headers. `/healthz` is logged at `debug`.

Endpoints: `/mcp` (the handler accepts the MCP methods after bearer auth), `GET /healthz`, and OAuth (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`). Redirect URIs are allowlisted.

**claude.ai:** Settings → Connectors → custom connector → `https://<your-host>/mcp`.  
**ChatGPT:** Connectors → MCP connector with the same URL.

### HTTPS

`PUBLIC_BASE_URL` must be the HTTPS origin, with no path. HTTP is allowed only for a loopback origin (`localhost`, `127.0.0.1`, `::1`).

- `cloudflared tunnel --url http://127.0.0.1:8080`, then set `PUBLIC_BASE_URL` to the printed `https` origin and restart.
- `tailscale funnel 8080`.
- A VPS with Caddy or nginx.
- Fly.io with this Dockerfile, `PUBLIC_BASE_URL=https://<app>.fly.dev`, and a volume at `/data`.

### Docker

The image is Node only. It does not include Playwright or a virtual display. Mount a volume so OAuth state and account tokens survive restarts:

```bash
docker build -t mcp-hellofresh .
docker run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL='https://hf-mcp.example.com' \
  -v /var/lib/mcp-hellofresh:/data \
  mcp-hellofresh
```

`/data/oauth-store.json` holds OAuth clients and hashed tokens. `/data/users/<userId>/tokens.json` holds one HelloFresh account.

`docker-compose.yml` runs the same image. Compose refuses to start when `PUBLIC_BASE_URL` is missing. The same variable can live in a `.env` file next to `docker-compose.yml`. The `hellofresh-data` volume is mounted at `/data`.

```bash
PUBLIC_BASE_URL='https://hf-mcp.example.com' docker compose up -d --build
```

## Local stdio (Claude Desktop / Claude Code)

One person, one process, one file. The file is `HELLOFRESH_ACCOUNT_PATH`, or `~/.config/mcp-hellofresh/account.json` (Windows: `%APPDATA%\mcp-hellofresh\account.json`). `XDG_CONFIG_HOME` is honored. This is not the HTTP `users/` directory.

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

Google, Apple, or Facebook accounts: on a machine with a display, run `npm run login` (or the `login` tool). Finish **Continue with Google** in the window. The command reads `apiV2Auth` and saves tokens to that file (mode `0600`). Do not type a Google password into the chat, the terminal, or an MCP prompt.

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
- Every MCP access token carries a HelloFresh account id. A token without one is rejected.
- `/authorize` stores the visitor's HelloFresh tokens on this server.
- Authorize attempts use the forwarding headers above, plus the email on password sign-in.
- `logout` removes one account. It does not sign you out of Google.
- Redirect URIs are allowlisted. The public URL must be HTTPS except on localhost.
- This does not bypass bot protection. If HelloFresh or Cloudflare blocks the call, the error says it is not a wrong password.

## License

MIT
