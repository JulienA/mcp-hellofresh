# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com) meal kit delivery. Enables AI assistants like Claude to manage your HelloFresh account — browse menus, select meals, manage deliveries, update preferences, and more.

## Features

| Tool | Description |
|------|-------------|
| `auth_status` | Whether a HelloFresh session exists and looks valid (no cookie values) |
| `login` | Open a headed browser so you can complete **Continue with Google** (not available in HTTP/headless mode) |
| `logout` | Delete the saved session and close the browser |
| `get_menu` | Browse current week's recipes with filters |
| `get_recipe_details` | Full recipe info: ingredients, instructions, nutrition |
| `select_meals` | Choose meals for an upcoming delivery |
| `skip_week` | Skip a delivery week |
| `get_delivery_schedule` | View all upcoming deliveries |
| `modify_delivery` | Change a delivery date |
| `get_preferences` | View dietary preferences and allergens |
| `update_preferences` | Update dietary/cuisine preferences |
| `get_subscription` | View current plan (servings, frequency, price) |
| `modify_subscription` | Change plan size or delivery frequency |
| `get_past_orders` | Browse order history |
| `rate_recipe` | Rate a recipe after cooking |

## Requirements

- Node.js 20+
- A HelloFresh account (Google SSO or a HelloFresh password account)
- Playwright Chromium (`npx playwright install chromium`)
- **A display** for the first Google sign-in (`login` tool or `npm run login`)

## Installation

```bash
npm install @striderlabs/mcp-hellofresh
npx playwright install chromium
```

## Authentication (Google SSO)

HelloFresh Google accounts **cannot** sign in with `HELLOFRESH_EMAIL` / `HELLOFRESH_PASSWORD`. This connector never stores, requests, or automates Google credentials. There is no `GOOGLE_PASSWORD` (or similar) setting.

**One-time interactive login:**

1. On a machine **with a screen**, from this package:
   ```bash
   npm run login
   ```
   or ask Claude to run the `login` tool (same headed Chromium window).
2. In the window, click **Continue with Google** and finish Google's sign-in yourself (including 2FA).
3. When HelloFresh shows a logged-in page, the tool saves Playwright `storageState` (HelloFresh cookies only, file mode `0600`) and closes the window.
4. Later MCP calls reload that file, probe it, and reuse it until it expires.

If the session expires, `auth_status` reports `valid: false` and other tools return `expired` / `missing_session` with *Session expired, run login again*. Repeat step 1. The server will **not** reopen Google SSO by itself.

Default session path: `~/.config/mcp-hellofresh/session.json`  
(Windows: `%APPDATA%\mcp-hellofresh\session.json`). Override with `HELLOFRESH_SESSION_PATH`.

`login` / `npm run login` need a display. On Linux set `DISPLAY` (or Wayland). If the MCP client runs headless **or you expose this server over HTTP**, use `npm run login` on a desktop, then copy `session.json` to the server and set `HELLOFRESH_SESSION_PATH`. The `login` tool will not open a browser in HTTP/headless mode.

Optional fallback **only** for HelloFresh password accounts (not Google):

```bash
export HELLOFRESH_EMAIL="your@email.com"
export HELLOFRESH_PASSWORD="your-hellofresh-password"
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hellofresh": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-hellofresh"]
    }
  }
}
```

Google SSO users should omit `env`. After installing, run `npm run login` once (or call the `login` tool from Claude Desktop on a machine with a screen).

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Usage with Claude Code

```bash
claude mcp add hellofresh -- npx -y @striderlabs/mcp-hellofresh
```

Then run `npm run login` once with a display.

## Remote HTTP (claude.ai and ChatGPT custom connectors)

Stdio is the default. Streamable HTTP is opt-in (`--http` or `MCP_HTTP=1`) so a **single owner** can attach this server as a custom connector in [claude.ai](https://claude.ai) and ChatGPT. HTTPS is required on the public URL.

This mode is **not** a multi-tenant HelloFresh proxy. One process, one HelloFresh account (the owner’s), one owner secret on the authorize page. The authorize page never asks for Google or HelloFresh credentials.

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `MCP_OWNER_PASSWORD` | yes* | Owner secret typed on `/authorize`. Not a Google password. |
| `MCP_OWNER_PASSWORD_HASH` | yes* | Alternative: `sha256:` plus hex digest of the owner secret |
| `PUBLIC_BASE_URL` | yes off localhost | Public origin, e.g. `https://hf-mcp.example.com` (no path) |
| `HOST` | no | Bind address (default `127.0.0.1`; Docker uses `0.0.0.0`) |
| `PORT` | no | Bind port (default `8080`) |
| `MCP_HTTP` | no | `1` / `true` enables HTTP without `--http` |
| `HELLOFRESH_SESSION_PATH` | recommended | Path to `session.json` produced by `npm run login` |
| `MCP_OAUTH_STORE_PATH` | no | Persisted OAuth clients/tokens (file mode `0600`) |
| `MCP_OAUTH_REDIRECT_HOSTS` | no | Comma-separated redirect hosts (default `claude.ai,claude.com,chatgpt.com`) |
| `MCP_OAUTH_ALLOW_LOOPBACK` | no | Set `0` to refuse `localhost` / `127.0.0.1` redirect URIs |
| `MCP_BEARER_TOKEN` | no | Optional static bearer token for other MCP clients (constant-time compare) |
| `MCP_AUTHORIZE_MAX_ATTEMPTS` | no | Authorize form rate limit (default `10`) |
| `MCP_AUTHORIZE_WINDOW_MS` | no | Rate-limit window in ms (default `900000`) |

\* HTTP mode refuses to start unless `MCP_OWNER_PASSWORD` or `MCP_OWNER_PASSWORD_HASH` is set.

To hash an owner secret: `node -e "const c=require('crypto'); console.log('sha256:'+c.createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-secret'`

Endpoints: `POST /mcp` (Streamable HTTP), `GET /healthz`, OAuth (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`). Tokens are stored hashed. Redirect URIs are allowlisted (Claude and ChatGPT callback hosts by default).

### 1. Create a HelloFresh session on a machine with a screen

Never automate Google sign-in. On your laptop:

```bash
npm run login
```

Complete **Continue with Google** in the headed window. Copy the session file to the server (mode `0600`):

```bash
# default path: ~/.config/mcp-hellofresh/session.json
scp ~/.config/mcp-hellofresh/session.json user@server:/var/lib/mcp-hellofresh/session.json
```

On the server: `export HELLOFRESH_SESSION_PATH=/var/lib/mcp-hellofresh/session.json`.

When the session expires, run `npm run login` again locally and recopy the file. The remote `login` tool will refuse to open a browser.

### 2a. Cloudflare Tunnel or Tailscale Funnel (from your machine)

Keep the process on the owner’s computer; the tunnel provides HTTPS.

```bash
export MCP_OWNER_PASSWORD='choose-a-long-owner-secret'
export HELLOFRESH_SESSION_PATH="$HOME/.config/mcp-hellofresh/session.json"
# After you know the public hostname:
export PUBLIC_BASE_URL='https://your-hostname.example'
npx mcp-hellofresh --http --host 127.0.0.1 --port 8080
```

**Cloudflare Tunnel** (quick URL, or a named tunnel with a stable hostname):

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Use the printed `https://*.trycloudflare.com` origin as `PUBLIC_BASE_URL` (restart once if you started the MCP server before the URL existed). A named tunnel with a fixed hostname is easier.

**Tailscale Funnel:**

```bash
tailscale funnel 8080
```

Set `PUBLIC_BASE_URL` to the Funnel HTTPS origin (`https://<machine>.<tailnet>.ts.net`).

### 2b. VPS or Fly.io

HTTPS must terminate in front of the process (Caddy, Caddy+HTTPS, Fly’s proxy, nginx, etc.). Set `PUBLIC_BASE_URL` to that HTTPS origin.

**Docker** (official Playwright image, non-root `pwuser`, session volume):

```bash
docker build -t mcp-hellofresh .
docker run --rm -p 8080:8080 \
  -e MCP_OWNER_PASSWORD='choose-a-long-owner-secret' \
  -e PUBLIC_BASE_URL='https://hf-mcp.example.com' \
  -v /var/lib/mcp-hellofresh:/data \
  mcp-hellofresh
```

Place `session.json` in the volume as `/data/session.json` (already the image default for `HELLOFRESH_SESSION_PATH`). OAuth state is `/data/oauth-store.json`.

**Fly.io:** `fly launch` with this Dockerfile, set secrets (`MCP_OWNER_PASSWORD`, `PUBLIC_BASE_URL=https://<app>.fly.dev`), and mount a volume at `/data` for `session.json`. Fly provides HTTPS.

### 3. Add the connector

**claude.ai:** Settings → Connectors → add a custom connector. URL: `https://<your-host>/mcp`. Claude registers (RFC 7591), opens `/authorize`, and you type the **owner secret**. Callback hosts `claude.ai` / `claude.com` are allowlisted by default.

**ChatGPT:** Settings → Connectors (or a custom GPT connector) → create an MCP connector with the same `https://<your-host>/mcp` URL. Complete the OAuth prompt with the owner secret. `chatgpt.com` is allowlisted by default.

Optional: clients that cannot do OAuth can send `Authorization: Bearer $MCP_BEARER_TOKEN` when that env var is set.

## Example Prompts

Once connected and logged in, you can ask Claude:

- "Am I logged into HelloFresh?"
- "What meals are available this week on HelloFresh?"
- "Show me the recipe details and nutrition for the teriyaki salmon"
- "Select the chicken tacos and mushroom pasta for next week's delivery"
- "Skip my HelloFresh delivery for week 2024-W05"
- "Change my delivery date to Friday January 12th"
- "Update my preferences to vegetarian and avoid nuts"
- "How many meals per week am I subscribed to? Can you change it to 3?"
- "Show me my last 5 HelloFresh orders"
- "I just made the lemon herb chicken — rate it 4 stars"

## Tool Reference

### `auth_status`
No parameters. Returns session path, `savedAt`, HelloFresh cookie **count**, and `valid` — never cookie values.

### `login`
No parameters. Opens headed Chromium. Complete Google SSO in that window. Requires a display. In HTTP/headless mode this tool fails and tells you to run `npm run login` locally, then copy `session.json`.

### `logout`
No parameters. Deletes the session file and closes Chromium.

### `get_menu`
```
week_offset (optional, 0-4): Week offset from current week
```

### `get_recipe_details`
```
recipe_id (required): The recipe identifier from get_menu
```

### `select_meals`
```
week_id (required): Week identifier, e.g. "2024-W01"
meals (required): Array of { recipe_id, servings? } objects
```

### `skip_week`
```
week_id (required): Week identifier to skip
```

### `get_delivery_schedule`
No parameters required.

### `modify_delivery`
```
week_id (required): Week identifier
new_date (required): New date in YYYY-MM-DD format
```

### `get_preferences`
No parameters required.

### `update_preferences`
```
vegetarian (optional): boolean
family_friendly (optional): boolean
dietary_preferences (optional): string[]
allergens (optional): string[]
cuisine_preferences (optional): string[]
```

### `get_subscription`
No parameters required.

### `modify_subscription`
```
meals_per_week (optional, 2-5): Number of meals
servings_per_meal (optional, 2-4): Number of servings
frequency (optional): "weekly" | "biweekly"
```

### `get_past_orders`
```
limit (optional, 1-50): Max orders to return (default: 10)
```

### `rate_recipe`
```
recipe_id (required): Recipe to rate
rating (required, 1-5): Star rating
comment (optional): Written review up to 500 chars
```

## How It Works

This connector uses [Playwright](https://playwright.dev) to drive the HelloFresh website. After you complete Google SSO once in a headed window, it reuses HelloFresh cookies from a local session file (headless) and probes that session before tools run. An expired session is not refreshed via Google; run `login` again. Password-account env vars, if set, may be used for a single automatic relogin.

**Note**: Website changes may affect functionality. Use responsibly and in accordance with HelloFresh's terms of service.

## Security

- Never store or automate Google credentials
- Session file contains HelloFresh cookies only (Google cookies are stripped), mode `0600`, outside the git repo by default
- HelloFresh email/password env vars are an optional fallback for non-SSO accounts only
- HTTP mode requires an owner secret (`MCP_OWNER_PASSWORD` or a SHA-256 hash). The authorize page is rate-limited. OAuth tokens are stored hashed in a `0600` file. Redirect URIs are allowlisted. The public URL must be HTTPS (HTTP is allowed only on localhost).

## License

MIT
