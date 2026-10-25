# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com) meal kit delivery. Enables AI assistants like Claude to manage your HelloFresh account — browse menus, select meals, manage deliveries, update preferences, and more.

## Features

| Tool | Description |
|------|-------------|
| `auth_status` | Whether a HelloFresh session exists and looks valid (no cookie values) |
| `login` | Open a headed browser so you can complete **Continue with Google** |
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

`login` / `npm run login` need a display. On Linux set `DISPLAY` (or Wayland). If the MCP client runs headless, use `npm run login` on a desktop, with `HELLOFRESH_SESSION_PATH` pointing at the same file the server reads.

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
No parameters. Opens headed Chromium. Complete Google SSO in that window. Requires a display.

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

## License

MIT
