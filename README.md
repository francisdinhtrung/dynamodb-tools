# dynamodb-tools

Read-only DynamoDB CLI (`ddb`) built for AI coding agents (GitHub Copilot agent mode, Claude Code, Cursor, Codex)
and humans. No MCP needed: the agent runs `ddb` in the terminal and reads JSON output.

## Install

**macOS / Linux / WSL (terminal):**

```bash
curl -fsSL https://raw.githubusercontent.com/francisdinhtrung/dynamodb-tools/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/francisdinhtrung/dynamodb-tools/main/install.ps1 | iex
```

Requires git and Node.js >= 22. The installer clones to `~/.dynamodb-tools`, puts `ddb` on your PATH
(`~/.local/bin/ddb` or `%USERPROFILE%\.dynamodb-tools-bin\ddb.cmd`) and installs the agent skill to
`~/.copilot/skills/dynamodb`. Run it again to update.

Options: `--no-skill`, `--claude-skill` (also `~/.claude/skills`), `--uninstall`
(PowerShell: download `install.ps1`, then `.\install.ps1 -NoSkill | -ClaudeSkill | -Uninstall`).

From a clone instead: `npm install && npm link`.

## Commands

```bash
ddb list-tables
ddb describe <table>
ddb get <table> --key pk=USER#1,sk=PROFILE
ddb query <table> --pk USER#1 --sk-begins ORDER# --desc --limit 10
ddb query <table> --index GSI1 --pk EMAIL#a@b.com
ddb scan <table> --limit 20 --projection pk,sk,status
ddb sample <table> -n 5
```

Global: `--profile`, `--region`, `--endpoint-url`, `--redact a,b`, `--pretty`.

## Safety

- The tool only calls `ListTables`, `DescribeTable`, `DescribeTimeToLive`, `GetItem`, `Query`, `Scan`.
  Still, give it a **read-only IAM identity**: see [iam-readonly-policy.json](iam-readonly-policy.json).
- `DDB_ALLOWED_TABLES="orders,app-dev-*"` restricts which tables can be read.
- `DDB_REDACT="email,phone"` (or `--redact`) masks sensitive attributes before they reach the LLM.
- Result size is capped (`--limit` default 20, max 100) with `nextToken` pagination.

## Use with Copilot / other agents

Agent instructions live in:

- `.github/skills/dynamodb/SKILL.md`: Agent Skill (VS Code Copilot, Claude Code, etc.)
- `.github/copilot-instructions.md`: always-on Copilot instructions
- `AGENTS.md`: for agents that read it

To use `ddb` from **another project**, after `npm link` either:

- copy `.github/skills/dynamodb/` into that repo's `.github/skills/`, or
- install it as a personal skill: `mkdir -p ~/.copilot/skills && cp -r .github/skills/dynamodb ~/.copilot/skills/`

Tip: set `AWS_PROFILE` / `DDB_ALLOWED_TABLES` / `DDB_REDACT` in that project's environment so the agent
never has to choose credentials.

## Local development

```bash
npm run local:up      # DynamoDB Local in Docker on :8000
npm run local:seed    # demo table "demo-app"
DDB_ENDPOINT_URL=http://localhost:8000 ddb query demo-app --pk USER#1
npm test              # unit tests (integration tests skipped)
npm run test:local    # unit + integration against DynamoDB Local
npm run local:down
```
