# @striderlabs/mcp-hellofresh

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector for [HelloFresh](https://www.hellofresh.com) meal kit delivery. Enables AI assistants like Claude to manage your HelloFresh account — browse menus, select meals, manage deliveries, update preferences, and more.

## Features

| Tool | Description |
|------|-------------|
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

- Node.js 18+
- A HelloFresh account
- Playwright browser (auto-installed)

## Installation

```bash
npm install @striderlabs/mcp-hellofresh
npx playwright install chromium
```

## Configuration

Authentication is **session-based**. Google SSO users cannot sign in via `HELLOFRESH_EMAIL` / `HELLOFRESH_PASSWORD` — do not put Google credentials in env or in the MCP config. Interactive Google SSO + persisted Playwright `storageState` is the planned primary path (not fully wired yet). Until then, tools return a structured `missing_session` error: *Session expired, run login again*.

Optional fallback for HelloFresh **password** accounts only:

```bash
export HELLOFRESH_EMAIL="your@email.com"
export HELLOFRESH_PASSWORD="yourpassword"
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

Google SSO users should omit `env` entirely. Password-account users may add optional `HELLOFRESH_EMAIL` / `HELLOFRESH_PASSWORD` (HelloFresh password, never a Google password).

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Usage with Claude Code

```bash
claude mcp add hellofresh -- npx -y @striderlabs/mcp-hellofresh
```

Then set env vars or add them to the MCP config.

## Example Prompts

Once connected, you can ask Claude:

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

This connector uses [Playwright](https://playwright.dev) browser automation to interact with the HelloFresh website on your behalf. It launches a headless Chromium browser, logs in with your credentials, and navigates the site to perform the requested actions.

**Note**: This connector interacts with the HelloFresh website through browser automation. Website changes may affect functionality. Use responsibly and in accordance with HelloFresh's terms of service.

## Security

- Never store or automate Google credentials. Google SSO must be completed by the user in an interactive browser (later step).
- HelloFresh email/password env vars are an optional fallback for non-SSO accounts only — never hardcoded
- The browser currently runs in headless mode with no persistent storage (session persistence is a later step)
- Sessions are not saved between server restarts yet

## License

MIT
