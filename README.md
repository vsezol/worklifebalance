# worklifebalance

How do you close work tasks while swimming in a pool?

Turn on your computer, start worklifebalance, and go ride a bike. Send `/new` to the Telegram bot — get a link to control Claude Code on your machine. From your phone, from anywhere.

A lightweight wrapper over Claude Code's [Remote Control](https://docs.anthropic.com/en/docs/claude-code) mode. Nothing extra gets installed. It's just regular Claude Code. You can configure it for your workflow.

Close tasks while riding a bike or swimming in a pool. Sitting at your desk all day is no longer required.

## How it works

1. You start the bot on your computer
2. Send `/new my-app` in Telegram
3. Bot spawns `claude remote-control` in the given directory
4. You get a `claude.ai/code` session link
5. Open it on your phone — full Claude Code, running on your machine
6. Status auto-updates in Telegram every 10 seconds

## Commands

| Command | Description |
|---------|-------------|
| `/new [dir] [name]` | Start a session. `dir` is relative to `DEFAULT_CWD`. `name` is optional (auto-generated). |
| `/list` | List all active sessions with URLs and uptime. |
| `/stop NAME` | Stop a session by name. |
| `/stopall` | Stop all active sessions. |
| `/status NAME` | Show session status with auto-updates. |

### Examples

```
/new                        # session in DEFAULT_CWD, random name
/new my-app            # session in DEFAULT_CWD/my-app, random name
/new my-app bugfix     # session in DEFAULT_CWD/my-app, name "bugfix"
/new /tmp/sandbox test      # absolute path, name "test"
```

## Setup

### Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated (`claude --version`)
- A Claude subscription (Max, Pro, or Team) with remote-control support

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot`, follow the prompts
3. Copy the bot token

### 2. Get your Telegram user ID

Send any message to [@userinfobot](https://t.me/userinfobot) — it replies with your user ID.

### 3. Find your Claude CLI path

```bash
which claude
# e.g. /Users/you/.local/bin/claude
```

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ALLOWED_USERS=123456789
DEFAULT_CWD=/home/you/projects
CLAUDE_PATH=/Users/you/.local/bin/claude
```

`ALLOWED_USERS` is a comma-separated list of Telegram user IDs. Only these users can interact with the bot. This is important — the bot runs sessions with `--permission-mode bypassPermissions`.

### 5. Install and run

```bash
npm install
npm run dev       # development (tsx)
# or
npm run build && npm start   # production
```

## MCP servers

Claude Code loads MCP servers from `~/.claude.json` based on the working directory. When the bot starts a session in `/home/you/projects/my-app`, Claude reads the MCP config for that project path.

### Atlassian MCP: OAuth problem and fix

The default Atlassian MCP (`https://mcp.atlassian.com/v1/mcp`) uses **OAuth**. This works in local terminal sessions but **fails in remote-control** because the OAuth token doesn't transfer to the remote bridge. You'll see:

> "You don't have permission to connect via API token."

**Fix**: replace the hosted OAuth MCP with [`mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) — a local stdio MCP server that uses a Jira API token.

#### Step 1: Create a Jira API token

https://id.atlassian.com/manage-profile/security/api-tokens

#### Step 2: Install

```bash
# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# Verify
uvx mcp-atlassian --help
```

#### Step 3: Configure in `~/.claude.json`

Find your project under `projects` and replace the atlassian MCP:

```json
{
  "projects": {
    "/home/you/projects/my-app": {
      "mcpServers": {
        "atlassian": {
          "command": "uvx",
          "args": ["mcp-atlassian"],
          "env": {
            "JIRA_URL": "https://yourcompany.atlassian.net",
            "JIRA_USERNAME": "you@company.com",
            "JIRA_API_TOKEN": "your_api_token"
          }
        }
      }
    }
  }
}
```

Claude spawns it as a subprocess — no OAuth, no browser, works in remote-control.

| | Hosted (`mcp.atlassian.com`) | Local (`mcp-atlassian`) |
|---|---|---|
| Auth | OAuth (browser) | API token (env var) |
| Transport | HTTP | stdio |
| Remote-control | Fails | Works |

Other stdio-based MCP servers (context7, local tools, etc.) work out of the box.

## Development

```bash
npm run dev      # run with tsx
npm test         # run tests (vitest)
npm run build    # compile typescript
```

Tests spawn real `claude remote-control` processes and verify URL capture.

## Security

- `ALLOWED_USERS` is mandatory — the bot ignores unknown users
- Only works in private chats (not groups)
- Sessions run with `--permission-mode bypassPermissions` — only give access to trusted users
- Tokens are in `.env` and `~/.claude.json` (never committed)

## License

MIT
