# Claude Plugins

A collection of custom plugins for Claude Code.

## Overview

This repository provides plugins that extend Claude Code's functionality. Each plugin offers unique features to enhance your development workflow.

## Plugins

### rules-on-create

A plugin that makes path-based rules in `.claude/rules/` (with `paths:` frontmatter) and path-targeted instructions in CLAUDE.md apply when Claude **creates** a new file, not only when it reads one. Works around [anthropics/claude-code#23478](https://github.com/anthropics/claude-code/issues/23478).

**How it works:**
- PreToolUse hook on `Write` intercepts writes to non-existing files
- Creates the file empty, then denies the Write with a reason telling Claude to Read it first
- After Read, path-based rules are injected; Claude then Writes/Edits with rules in context

**Prerequisites:**
- `jq` available on `PATH`

See [plugins/rules-on-create](plugins/rules-on-create) for more details.

### package-manager-enforcer

A plugin that blocks Claude from running a package manager command that does not match the project's detected package manager (e.g. running `npm install` in a `pnpm`-based project).

**How it works:**
- PreToolUse hook on `Bash` intercepts every Bash command
- Detects the project's package manager from `package.json#packageManager` field or lock file
- Blocks with exit 2 when the command's manager differs from the detected one
- `npx` is always allowed; non-package-manager commands pass through

**Prerequisites:**
- `node` available on `PATH`

See [plugins/package-manager-enforcer](plugins/package-manager-enforcer) for more details.

### plan-rule-review

A plugin that reviews the plan for compliance with project rules (CLAUDE.md / `.claude/rules/`) before allowing Plan Mode to exit. Helps catch rule violations before implementation begins.

**How it works:**
- PreToolUse hook on `ExitPlanMode` intercepts plan finalization
- Denies exit and injects review instructions into Claude's context
- Claude reads CLAUDE.md and `.claude/rules/` files and reviews the plan for violations
- If violations are found, Claude revises the plan and retries `ExitPlanMode`
- After the configured number of reviews (default: 2), exit is always allowed

**Prerequisites:**
- `node` available on `PATH`

**Configuration:**
- `PLAN_RULE_REVIEW_MAX` — max reviews per session (default: `2`; set to `0` to disable)

See [plugins/plan-rule-review](plugins/plan-rule-review) for more details.

### auto-simplify-hook

A plugin that blocks Claude from stopping when there are 10+ changed lines and `/simplify` has not been run in the current session. Encourages code simplification before finishing a task.

**How it works:**
- Stop hook checks `git diff HEAD --numstat` to count changed lines (added + deleted)
- If changes are 10 lines or more and `/simplify` is not found in the transcript, returns `decision: block`
- Skips when `stop_hook_active` is `true` to prevent infinite loops
- Skips in non-git directories

**Prerequisites:**
- `jq` available on `PATH`
- `git` available on `PATH`

See [plugins/auto-simplify-hook](plugins/auto-simplify-hook) for more details.

## Installation

### Prerequisites

- [Claude Code](https://claude.com/claude-code) installed
- Git environment set up

## License

MIT License
