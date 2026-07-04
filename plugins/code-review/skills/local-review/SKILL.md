---
name: local-review
description: ローカルブランチの変更に対して、複数の専門エージェント（CLAUDE.md準拠/バグ検出/REVIEW.md準拠）を並列起動して多角的なコードレビューを実施するスキル。PR作成前のレビューに使用する。
allowed-tools: Bash(git:*), Bash(node:*), Bash(jq:*)
disable-model-invocation: true
---

指定された範囲のローカルgit変更に対してコードレビューを行います。

引数: `[<range>]`
- 引数なし: **ステージ済み変更（`git diff --staged`）があればそれを優先してレビュー対象にする**（コミット前レビュー）。ステージ済み変更がなければブランチ設定から base を自動解決（`github-pr-base-branch` → `vscode-merge-base` → `@{upstream}` → `origin/HEAD` の順）
- `main`: base のみ指定 → `main...HEAD` として補完
- `main...HEAD` / `main..HEAD`: そのまま使用
- `abc123..def456`: 任意のコミット間

## モード別パラメータ

`${CLAUDE_PLUGIN_ROOT}/shared/review-core.md` の**太字名**に、local-review では以下の値を与える:

| パラメータ | 値 |
|---|---|
| **context引数** | `--range [<range>]`（引数なしなら `--range` のみ。スクリプトが staged/range を自動判別） |
| **サマリエージェント入力** | `git log --format="%H%n%s%n%b%n---" <range>`（コミットメッセージ一覧。ただし `source` が `"staged"` の場合はコミットが無いため `git log` は実行せず、統一 diff のみからサマリを作成する）+ 統一 diff |
| **著者意図情報** | ステップ2の `summary`（ローカルには PR 説明文が無く `summary` が唯一の著者意図情報） |
| **ステップ3の起動タイミング** | ローカルには著者意図情報が `summary` しかないため、**全エージェントがステップ2の完了を待って起動する**（`summary` を著者意図として渡すため） |
| **サマリ失敗時の縮退** | サマリが唯一の著者意図情報のため、失敗時は各エージェントを著者意図情報なし（diff・ルール・観点のみ）で起動する。ステップ8に「変更概要」は無い |
| **既存問題の基準** | 「このブランチ以前から」 |
| **ステップ8の追加要素と完了後の動作** | 追加要素なし（冒頭に「変更概要」は載せない）。ステップ8で終了する（GitHub への投稿は行わない） |

## 実行

`${CLAUDE_PLUGIN_ROOT}/shared/review-core.md` を読み込み、上記モード別パラメータを適用してステップ1〜8を**一字一句そのとおりに実行する**。独自の追加・省略・解釈変更をしない。ステップ8まで完了したら終了する。
