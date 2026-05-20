# Claude Plugins

A collection of custom plugins for Claude Code.

## Overview

This repository provides plugins that extend Claude Code's functionality. Each plugin offers unique features to enhance your development workflow.

## Plugins

### claude-md-compliance

A plugin for checking code compliance with CLAUDE.md guidelines and automatic fixes.

**Features:**
- Code review based on project's CLAUDE.md guidelines
- Automatic detection and fixing of guideline violations
- Batch review of uncommitted changes

**Commands:**
- `/claude-md-compliance:claude-md-fix [filename]` - Automatically fix guideline violations in the specified file
- `/claude-md-compliance:claude-md-review` - Review uncommitted changes and fix them as needed

See [plugins/claude-md-compliance](plugins/claude-md-compliance) for more details.

### rules-on-create

A plugin that makes path-based rules in `.claude/rules/` (with `paths:` frontmatter) and path-targeted instructions in CLAUDE.md apply when Claude **creates** a new file, not only when it reads one. Works around [anthropics/claude-code#23478](https://github.com/anthropics/claude-code/issues/23478).

**How it works:**
- PreToolUse hook on `Write` intercepts writes to non-existing files
- Creates the file empty, then denies the Write with a reason telling Claude to Read it first
- After Read, path-based rules are injected; Claude then Writes/Edits with rules in context

**Prerequisites:**
- `jq` available on `PATH`

See [plugins/rules-on-create](plugins/rules-on-create) for more details.

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
