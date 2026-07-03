---
name: code-review
description: "【非推奨: /code-review:pr-review を使用してください】指定されたGitHubプルリクエストに対して、複数の専門エージェント（CLAUDE.md準拠/バグ検出/REVIEW.md準拠）を並列起動して多角的なコードレビューを実施するスキル。"
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh repo view:*), Bash(gh api:*), Bash(git rev-parse:*), Bash(git diff:*), Bash(node:*), Bash(jq:*)
disable-model-invocation: true
---

このスキルは後方互換のために残されています。レビューロジックは `pr-review` スキルに集約されているため、本スキルは `pr-review` の手順をそのまま実行します（今後の新規利用は `/code-review:pr-review` を推奨）。

以下の手順を実行してください:

1. `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/SKILL.md` を読み込む。
2. そこに記載された手順を、本スキルに渡された引数（PR番号、および `--comment` の有無）をそのまま使ってそのとおりに実行する。
3. 委譲先（`pr-review`）の指示を一字一句の差異なく適用する。本スキル独自の追加・省略・解釈の変更は行わないこと。
