# Claude Plugins

## Project Structure

- `plugins/<name>/claude-plugin/plugin.json` — plugin manifest
- `plugins/<name>/hooks/` — hook scripts
- `.claude-plugin/marketplace.json` — plugin registry (must stay in sync with plugins/)

## Adding a New Plugin

1. Create `plugins/<name>/claude-plugin/plugin.json` and `plugins/<name>/hooks/`
2. Add an entry to `.claude-plugin/marketplace.json`

## Prerequisites

- `jq` (used by several hooks)
- `node` (used by package-manager-enforcer)
