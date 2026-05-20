# rules-on-create

新規ファイル作成時に `.claude/rules/` のパス指定ルールや CLAUDE.md のパス指定指示を確実に反映させるプラグインです。

## 背景

Claude Code の `.claude/rules/` には `paths:` フロントマターを使ってパス別のルールを定義できます。しかし現状、これらのルールは対象パスを **Read したときのみ** context に注入され、**Write（新規作成）時には注入されません**。

例えば「新しい `.ts` ファイルには必ずヘッダーコメントを入れる」というルールを書いても、Write で新規作成した場合は Claude がそのルールを見ていないため無視されます。

この問題は [anthropics/claude-code#23478](https://github.com/anthropics/claude-code/issues/23478) で報告されています。

## しくみ

`PreToolUse(Write)` フックが以下の流れで動作します：

1. **既存ファイルへの Write** → フックは素通し（通常どおり Write が実行される）
2. **新規ファイルへの Write** → フックが空ファイルを作成し Write を deny（拒否）
3. Claude は deny の理由を読み、`Read` を実行する
4. Read によってパスベースのルールが context に注入される
5. Claude が再度 Write/Edit を実行し、ルールが適用された内容で保存される

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install rules-on-create@plugin-hub
```

インストール後は Claude Code を再起動してください。

## 動作確認

1. テスト用ルールを作成する（例：`src/**/*.ts` にマッチするルール）

   ```markdown
   ---
   paths:
     - "src/**/*.ts"
   ---
   # Test rule
   All new TypeScript files MUST include the header comment `// TEST RULE LOADED`.
   ```

2. Claude に新しい `.ts` ファイルの作成を依頼する

3. 期待される動作：
   - Claude が `Write` を呼ぶ → フックが空ファイルを作成して deny を返す
   - Claude が `Read` を実行する → パスベースのルールが context に注入される
   - Claude が再度 Write/Edit でルールを適用した内容を書き込む

### フックスクリプトの単体テスト

```bash
# 空の file_path → 素通し（出力なし）
echo '{"tool_input":{"file_path":""}}' | \
  bash plugins/rules-on-create/hooks/pre-write-force-read.sh

# 既存ファイル → 素通し（出力なし）
echo '{"tool_input":{"file_path":"README.md"}}' | \
  bash plugins/rules-on-create/hooks/pre-write-force-read.sh

# 未存在ファイル → deny JSON + 空ファイル作成
TMP=$(mktemp -d)
echo "{\"tool_input\":{\"file_path\":\"$TMP/new.ts\"}}" | \
  bash plugins/rules-on-create/hooks/pre-write-force-read.sh
ls -la "$TMP/new.ts"  # 空ファイルが存在することを確認
```

## 前提

- `jq` が `PATH` 上にあること（macOS なら `brew install jq`）

## 既知の制限

- `Edit` / `MultiEdit` には適用しない（既存ファイルが前提のためそもそも問題が発生しない）
- 全 Write を対象とするため、ファイルの種類によるフィルタはない
- 新規ファイル作成時に空ファイルが一時的に作成される副作用がある
- `tool_input.file_path` が空または存在しないリクエストはスルーされる
