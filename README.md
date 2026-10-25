# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com). One HTTP server stores many HelloFresh accounts. Each connector signs in on the `/sign-in` page (started from `/oauth2/authorize`) to its own account. Tools call HelloFresh's `/gw` API for that account only.

This API is unofficial and can change. A bot-protection block is not a wrong password.

## Features

| Tool | Description |
|------|-------------|
| `auth_status` | Email, country, whether the access token is still valid, and when it was saved. Never returns tokens. |
| `login` | Local stdio: open a headed window so you can finish **Continue with Google**, then save `apiV2Auth`. HTTP: tells you to disconnect and reconnect the connector. |
| `logout` | Delete the saved tokens for this account only. |
| `get_menu` | Menu for an upcoming week, with prep time, the card label, tags, calories, and allergens. Hosts that support MCP Apps also show recipe cards. |
| `get_recipe_details` | Recipe payload from `/gw/recipes`. Hosts that support MCP Apps also show one recipe card. |
| `get_recipe_image` | Recipe photo from the HelloFresh CDN |
| `select_meals` | Save a meal selection for a week. `quantity` is how many cartons of each recipe. |
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

- Node.js 22.13+ (HTTP uses the built-in `node:sqlite` module)
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

One process stores many HelloFresh accounts. The account id is the SHA-256 of the country code, a newline, and the trimmed lowercased email. The same country and email from Claude and from ChatGPT share `users/<userId>/tokens.json` in the users directory. That file is mode `0600` and encrypted with `MCP_DATA_KEY`. Another country is another account.

HelloFresh does not offer third-party OAuth. Claude and ChatGPT complete OAuth against this server. The authorization server is [Better Auth](https://www.better-auth.com) with `@better-auth/mcp` (JWT access tokens, PKCE S256, DCR, refresh rotation, revocation, RFC 8414/9728, CIMD). The MCP TypeScript SDK owns `/mcp` transport and the bearer gate. `jose` verifies JWT signatures against the library JWKS.

The HelloFresh sign-in happens in the browser, on the Better Auth login page (`/sign-in`), and only for that person:

1. Choose the country.
2. Either enter the HelloFresh email and password (not a Google, Apple, or Facebook password), or sign in on the HelloFresh website yourself — **Continue with Google** included — and paste the `apiV2Auth` value from that browser.
3. The server keeps the HelloFresh access token and refresh token, checks `GET /gw/api/customers/me/subscriptions`, and discards the password and the raw paste.

The password is never stored. HelloFresh access tokens refresh from the saved refresh token. When HelloFresh rejects the refresh, disconnect the connector and connect it again.

Anyone who can finish OAuth against this server can store their HelloFresh tokens on it. Default redirect hosts are `claude.ai`, `claude.com`, and `chatgpt.com`. Loopback redirects stay allowed unless `MCP_OAUTH_ALLOW_LOOPBACK=0`. Publish the hostname only when that is intended.

MCP access tokens are signed EdDSA JWTs (one hour). Refresh tokens last 30 days, are stored hashed in SQLite, and rotate on use. JWT access tokens carry the HelloFresh account id as `userId`.

**Migration:** existing opaque MCP tokens and `oauth-store.json` are not imported. Disconnect each connector in Claude/ChatGPT and connect it again. HelloFresh account files in `users/` stay valid if `MCP_DATA_KEY` is unchanged.

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `MCP_DATA_KEY` | yes | 32-byte AES-256-GCM key, as base64, base64url, or hex. Encrypts HelloFresh account tokens and the local stdio session file. Also used as the Better Auth secret unless `BETTER_AUTH_SECRET` is set. |
| `BETTER_AUTH_SECRET` | no | 32+ character secret for Better Auth cookies and JWT private-key encryption. Defaults to `MCP_DATA_KEY`. |
| `PUBLIC_BASE_URL` | yes off localhost | Public HTTPS origin, e.g. `https://hf-mcp.example.com` (no path) |
| `HOST` | no | Bind address (default `127.0.0.1`; Docker uses `0.0.0.0`) |
| `PORT` | no | Bind port (default `8080`) |
| `MCP_HTTP` | no | `1`, `true`, or `yes` enables HTTP without `--http` |
| `MCP_AUTH_DB_PATH` | no | SQLite file for OAuth clients, authorization codes, refresh tokens, and JWKS (mode `0600`). Default `~/.config/mcp-hellofresh/auth.sqlite`, or `%APPDATA%\mcp-hellofresh\auth.sqlite` on Windows. `XDG_CONFIG_HOME` is honored. |
| `MCP_USERS_DIR` | no | Per-account token directory. Default is the `users` directory next to the auth database. |
| `MCP_OAUTH_REDIRECT_HOSTS` | no | Comma-separated redirect hosts (default `claude.ai,claude.com,chatgpt.com`) |
| `MCP_OAUTH_ALLOW_LOOPBACK` | no | Set `0` to refuse loopback redirect URIs (`localhost`, `127.0.0.1`, `::1`) |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, or `error`. JSON lines on stderr. `/healthz` is `debug`. |

Generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Keep it in the environment only, not in the image and not in git. A short passphrase is rejected. An existing plaintext HelloFresh token file is still read once when the key is set, then rewritten encrypted on the next save. Without the key, the process refuses to start and those files cannot be read.

Better Auth rate-limits OAuth endpoints (token, authorize, register, revoke) and `/sign-in` (10 attempts / 15 minutes). JWT signing keys are generated on first start, encrypted by Better Auth, and stored in the SQLite JWKS table.

JSON logs go to stderr (`docker compose logs`). Each line has `ts`, `level`, and `msg` (`http.request`, `oauth.authorize`, `oauth.register`, `mcp.tool`, `hellofresh.request`). They include method, path, status, duration, OAuth outcome, tool name, and a truncated account id. They do not include passwords, tokens, emails, or `Authorization` headers. `/healthz` is logged at `debug`.

Endpoints: `/mcp` (MCP methods after JWT bearer auth), `GET /healthz`, `/sign-in` (HelloFresh link), and Better Auth OAuth (`/.well-known/oauth-authorization-server`, `/jwks`, `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register`, `/oauth2/revoke`). RFC 9728 resource metadata is served by the MCP SDK. Redirect URIs are allowlisted.

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
  -e MCP_DATA_KEY='paste-32-byte-base64url-key' \
  -v /var/lib/mcp-hellofresh:/data \
  mcp-hellofresh
```

`/data/auth.sqlite` holds Better Auth OAuth state and JWKS (mode `0600`). `/data/users/<userId>/tokens.json` holds one HelloFresh account, encrypted with `MCP_DATA_KEY`. Keep the volume so signing keys and refresh tokens survive restarts.

`docker-compose.yml` runs the same image. Compose refuses to start when `PUBLIC_BASE_URL` or `MCP_DATA_KEY` is missing. The same variables can live in a `.env` file next to `docker-compose.yml`. The `hellofresh-data` volume is mounted at `/data`. The key is not written into the image.

```bash
PUBLIC_BASE_URL='https://hf-mcp.example.com' MCP_DATA_KEY='paste-32-byte-base64url-key' docker compose up -d --build
```

## Local stdio (Claude Desktop / Claude Code)

One person, one process, one file. The file is `HELLOFRESH_ACCOUNT_PATH`, or `~/.config/mcp-hellofresh/account.json` (Windows: `%APPDATA%\mcp-hellofresh\account.json`). `XDG_CONFIG_HOME` is honored. This is not the HTTP `users/` directory. `MCP_DATA_KEY` encrypts that file, and the process will not start without it.

```json
{
  "mcpServers": {
    "hellofresh": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-hellofresh"],
      "env": {
        "HELLOFRESH_COUNTRY": "fr",
        "MCP_DATA_KEY": "paste-32-byte-base64url-key"
      }
    }
  }
}
```

Password accounts can set `HELLOFRESH_EMAIL` and `HELLOFRESH_PASSWORD`. Those are sent once to `POST /gw/login` and are not written to disk. If the refresh token later dies, the process may sign in again with those env vars.

Google, Apple, or Facebook accounts: on a machine with a display, run `npm run login` (or the `login` tool). Finish **Continue with Google** in the window. The command reads `apiV2Auth` and saves tokens to that file (mode `0600`, encrypted with `MCP_DATA_KEY`). Do not type a Google password into the chat, the terminal, or an MCP prompt.

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

`get_menu`: `week_offset` optional, 0–4. Each recipe includes `prepTime` (minutes, or `null`), `label` (card badge), `tags`, `calories` (kcal per portion, or `null`), `allergens`, and `allergenTraces`. `get_recipe_details` is for ingredients, steps, and the full nutrition table. The text result stays that JSON. Hosts that render MCP Apps also read `structuredContent` into recipe cards (`ui://hellofresh/menu`). Photos are public `img.hellofresh.com` URLs, not downloaded bytes.

`get_recipe_details`: `recipe_id` required. The text result is the HelloFresh payload. The card (`ui://hellofresh/recipe`) shows the name, photo, tags, and prep time.

`get_recipe_image`: `recipe_id` required. Returns the photo and its public `img.hellofresh.com` URL. A CloudFront `imageLink` is not fetched; the tool uses `imagePath`, or the `/image/...` part of that link.

`select_meals`: `week_id` required, `meals` required. Each meal has `recipe_id` and optional `quantity` (1–10, default 1). `quantity` is how many cartons of that recipe go in the box, so `2` orders the same recipe twice. The same recipe listed twice has its quantities added, up to 10. Portions per meal stay on the subscription plan. Use `modify_subscription` to change them.

`skip_week`: `week_id` required.

`modify_delivery`: `week_id` and `new_date` (`YYYY-MM-DD`) required. The date must match a HelloFresh delivery option.

`update_preferences`: optional `vegetarian`, `family_friendly`, `dietary_preferences`, `allergens`, `cuisine_preferences`.

`modify_subscription`: optional `meals_per_week` (2–5), `servings_per_meal` (2–4), `frequency` (`weekly` or `biweekly`). Frequency is not sent to HelloFresh; the result says it was left unchanged.

`get_past_orders`: optional `limit` (1–50, default 10). Each order is a week (`orderId`, `menuId`) and the meals HelloFresh returned for it. Meals use the same fields as `get_menu`, plus `websiteURL` and `cuisines` when present. `deliveryDate`, `status`, and `totalPrice` are `null` when that response omits them. Older weeks follow the `nextWeek` cursor until `limit`.

`rate_recipe`: kept so older clients still see the tool. It returns an error. Rate the recipe on the HelloFresh website.

## Security

- Never store or automate a Google, Apple, or Facebook password. The login page has no field for one.
- A HelloFresh password is used only for that `/gw/login` request. It is not stored, logged, or returned to the model.
- HelloFresh account files and the local stdio session file are encrypted with AES-256-GCM. The key lives only in `MCP_DATA_KEY`. Files stay mode `0600`.
- OAuth clients, refresh tokens, and JWKS live in Better Auth's SQLite database. JWT private keys are encrypted by Better Auth. Refresh tokens are hashed.
- A previous plaintext HelloFresh token file is read once when the key is set, and rewritten encrypted on the next save. The key is never logged.
- Every MCP access token is a signed JWT. `/mcp` verifies signature, `iss`, `aud` (RFC 8707 resource), `exp`, and `mcp` scope with `jose`, then requires `userId`.
- `/sign-in` stores the visitor's HelloFresh tokens on this server. The form uses Better Auth origin checks plus a signed OAuth query, and sets `frame-ancestors 'none'`.
- `logout` removes one account. It does not sign you out of Google.
- Redirect URIs are allowlisted. The public URL must be HTTPS except on localhost.
- This does not bypass bot protection. If HelloFresh or Cloudflare blocks the call, the error says it is not a wrong password.

## License

MIT
