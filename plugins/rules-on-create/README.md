# rules-on-create

新規ファイル作成時に `.claude/rules/` のパス指定ルールや CLAUDE.md のパス指定指示を確実に反映させるプラグインです。

## 背景

Claude Code の `.claude/rules/` には `paths:` フロントマターを使ってパス別のルールを定義できます。しかし現状、これらのルールは対象パスを **Read したときのみ** context に注入され、**Write（新規作成）時には注入されません**。

例えば「新しい `.ts` ファイルには必ずヘッダーコメントを入れる」というルールを書いても、Write で新規作成した場合は Claude がそのルールを見ていないため無視されます。

この問題は [anthropics/claude-code#23478](https://github.com/anthropics/claude-code/issues/23478) で報告されています。

## しくみ

`PreToolUse(Write)` フックが以下の流れで動作します：

1. **既存ファイルへの Write** → フックは素通し（通常どおり Write が実行される）
2. **ルールが該当する新規ファイルへの Write のみ** → フックが空ファイルを作成し Write を deny（拒否）
3. Claude は deny の理由を読み、`Read` を実行する
4. Read によってパスベースのルールが context に注入される
5. Claude が再度 Write/Edit を実行し、ルールが適用された内容で保存される

ルールが該当しない新規ファイルは素通しになります（空ファイルは作られません）。

### 該当判定

以下のいずれかを満たす場合のみ deny します：

- **A. ルール glob 該当**: `.claude/rules/**/*.md` のいずれかが `paths:` フロントマターを持ち、対象ファイルのプロジェクト相対パスが少なくとも 1 つの glob にマッチする
- **B. 祖先 CLAUDE.md 存在**: 対象ファイルのディレクトリ、または祖先ディレクトリ（**プロジェクトルート直下は除く**）に `CLAUDE.md` が存在する

プロジェクトルート直下の `CLAUDE.md` は常時 context にロードされるため、判定対象外としています。

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
# 1. 空の file_path → 素通し（出力なし）
echo '{"tool_input":{"file_path":""},"cwd":"'"$PWD"'"}' \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs

# 2. 既存ファイル → 素通し（出力なし）
echo '{"tool_input":{"file_path":"README.md"},"cwd":"'"$PWD"'"}' \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs

# 3. 該当ルール無し新規 → 素通し（空ファイルも作られない）
TMP=$(mktemp -d); (cd "$TMP" && git init -q)
echo "{\"tool_input\":{\"file_path\":\"$TMP/new.ts\"},\"cwd\":\"$TMP\"}" \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs
test ! -e "$TMP/new.ts" && echo "OK: not created"

# 4. .claude/rules マッチ → deny + 空ファイル作成
mkdir -p "$TMP/.claude/rules"
printf -- '---\npaths:\n  - "**/*.ts"\n---\nTS rule\n' > "$TMP/.claude/rules/ts.md"
echo "{\"tool_input\":{\"file_path\":\"$TMP/new.ts\"},\"cwd\":\"$TMP\"}" \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs
test -e "$TMP/new.ts" && echo "OK: created"

# 5. 祖先 CLAUDE.md による該当 → deny
rm -rf "$TMP/.claude/rules" "$TMP/new.ts"
mkdir -p "$TMP/sub"; touch "$TMP/sub/CLAUDE.md"
echo "{\"tool_input\":{\"file_path\":\"$TMP/sub/foo.ts\"},\"cwd\":\"$TMP\"}" \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs
test -e "$TMP/sub/foo.ts" && echo "OK: created"

# 6. プロジェクトトップの CLAUDE.md のみ → 素通し
rm "$TMP/sub/CLAUDE.md" "$TMP/sub/foo.ts"; touch "$TMP/CLAUDE.md"
echo "{\"tool_input\":{\"file_path\":\"$TMP/sub/bar.ts\"},\"cwd\":\"$TMP\"}" \
  | node plugins/rules-on-create/hooks/pre-write-force-read.mjs
test ! -e "$TMP/sub/bar.ts" && echo "OK: not created"
```

実機確認は `/plugin reinstall rules-on-create` 後、`.claude/rules/` 有り / 無しのプロジェクトでそれぞれ Write を試して挙動を比較。

## 前提

- `node` v20+ が `PATH` 上にあること（`fs/promises.glob` を使用）

## 既知の制限

- `Edit` / `MultiEdit` には適用しない（既存ファイルが前提のためそもそも問題が発生しない）
- プロジェクトルート直下の `CLAUDE.md` は判定対象外（常時 context にロードされるため）
- サポートする glob 構文は `**` / `*` / `?` / `{a,b}` / `[abc]` の範囲（picomatch 固有の `!(..)` 等は非サポート）
- 新規ファイル作成時に空ファイルが一時的に作成される副作用がある（deny 時のみ）
