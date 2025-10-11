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

## Installation

### Prerequisites

- [Claude Code](https://claude.com/claude-code) installed
- Git environment set up

## License

MIT License
