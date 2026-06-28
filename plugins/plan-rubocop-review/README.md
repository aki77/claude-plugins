# plan-rubocop-review

Plan Mode 終了時（`ExitPlanMode`）に、プラン本文中に書かれた **Ruby コードブロック**を RuboCop（プロジェクトの `.rubocop.yml` 準拠）で検証するプラグインです。実装着手前にスタイル・規約違反を潰すことを狙います。

## 背景

Claude Code の Plan Mode では、実装前のプランに具体的な Ruby コードが含まれることがあります。しかしそのコードが RuboCop を通るかは実装してみるまで分かりません。

このプラグインは `ExitPlanMode` を `PreToolUse` フックで捕捉し、`plan-rubocop-review-run` スキルを起動して、プランに書かれた Ruby コードブロックを `rubocop --stdin <想定パス>` で検証します。違反があればプラン内のコードを修正させてから実装に進ませます。

## しくみ

`PreToolUse(ExitPlanMode)` フックと `plan-rubocop-review-run` スキルが以下の流れで動作します：

1. Claude がプランを書き `ExitPlanMode` を呼ぶ → フックが発火する
2. プランに「検証済み・違反なし」を示すマーカー（`<!-- plan-rubocop-review: passed -->`）が含まれていれば、フックは即座に素通し（`ExitPlanMode` を許可）する
3. プラン本文に `` ```ruby `` コードブロックが 1 つも無ければ、フックは検証対象なしと見なして即座に素通しする（deny もスキル起動もせず、検証回数も消費しない）
4. マーカーがなく `` ```ruby `` ブロックを含み、セッションあたりの検証回数が上限未満なら、`ExitPlanMode` を deny（拒否）し、「`plan-rubocop-review:plan-rubocop-review-run` スキルを実行せよ」という指示とプラン全文を Claude の context に注入する
5. Claude 本体は `plan-rubocop-review-run` スキルを起動し、その手順に従う:
   1. プラン本文から ` ```ruby ` コードブロックを列挙し、各ブロックの**本来の配置パス**を直前の見出し・記述から推定する（推定できないブロックは検証をスキップ）
   2. `rubocop-stdin.mjs` にコードと推定パスを渡し、検証先プロジェクトのルートで `bundle exec rubocop --server --stdin <path> --format json --force-exclusion` を実行する（**ファイルは作成・変更せず `--stdin` でメモリ上で検証**）。[RuboCop server mode](https://docs.rubocop.org/rubocop/latest/usage/server.html) を使うため初回でサーバが常駐してブート時間を削減し、全ブロック検証後にスクリプトが `--stop-server` でサーバを停止する
   3. 違反があればプラン内の該当コードブロックを RuboCop 指摘に沿って修正し、マーカーは付けずに再度 `ExitPlanMode` を呼ぶ
   4. 違反がなければプラン末尾にマーカーを追記して `ExitPlanMode` を呼ぶ → ステップ 2 で即座に許可される
   5. 検証したブロック数・スキップしたブロック数・違反件数を必ずユーザーに報告する
6. マーカーが付かないまま検証回数が上限に到達すると、フックは素通し（`ExitPlanMode` を許可）し、無限ループを防ぐ

RuboCop の判定は終了コード／JSON で決定論的に出るため、`plan-rule-review` のようなレビュー専用サブエージェントへの委譲は行わず、本体が直接検証します。

### カスタマイズ

検証手順・パス推定方針・出力形式はすべて [`skills/plan-rubocop-review-run/SKILL.md`](skills/plan-rubocop-review-run/SKILL.md) に Markdown で記述されています。挙動を変えたい場合はフックスクリプト（`.mjs`）ではなくこの `SKILL.md` を編集してください。RuboCop 実行のラッパは [`skills/plan-rubocop-review-run/scripts/rubocop-stdin.mjs`](skills/plan-rubocop-review-run/scripts/rubocop-stdin.mjs) にあります。

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install plan-rubocop-review@plugin-hub
```

インストール後は Claude Code を再起動してください（フックは再起動後のセッションから有効になります）。

## 設定

| 環境変数 | 説明 | デフォルト |
| --- | --- | --- |
| `PLAN_RUBOCOP_REVIEW_MAX` | セッションあたりの最大検証回数（マーカーが付かないまま繰り返された場合の無限ループ防止上限） | `2` |

通常は違反のないプランにマーカーが付くことで 1 回の検証で通過するため、`PLAN_RUBOCOP_REVIEW_MAX` は「マーカーが付かないまま `ExitPlanMode` が繰り返された場合」のセーフティネットとして機能します。

`0` を指定すると検証を無効化できます（常に `ExitPlanMode` を許可）。

検証回数はセッション単位（`session_id`）で `${TMPDIR}/plan-rubocop-review-sessions.json` に記録されます。24 時間以上古いエントリは自動的にクリーンアップされます。

## plan-rule-review との併用

[`plan-rule-review`](../plan-rule-review/) プラグインと**併用可能**です。両者は同じ `PreToolUse(ExitPlanMode)` で発火しますが、名前空間（セッションファイル名・マーカー文字列・環境変数名・スキル名）がすべて別物のため、セッション管理とマーカー判定は混線しません。

- 両方がインストールされていると、初回の `ExitPlanMode` で両フックが deny し、本体に 2 つのスキル実行指示が同時に注入されます。本体は両スキルを順に実行し、各自のマーカー（`<!-- plan-rule-review: passed -->` と `<!-- plan-rubocop-review: passed -->`）を付けます。両マーカーが揃った再 `ExitPlanMode` で両フックとも素通しし、承認に進みます。
- 片方のスキルがプランを修正して再 `ExitPlanMode` しても、各フックは自分のマーカーの有無だけを見るため、すでに通過した側は再検証されません。
- セッション上限（`PLAN_RULE_REVIEW_MAX` / `PLAN_RUBOCOP_REVIEW_MAX`）は独立にカウントされ、無限ループ防止も独立して機能します。

## 動作確認

### フックスクリプトの単体テスト

プラン本文は `` ```ruby `` ブロックを含むものを使う（含まないプランは早期スキップで素通しになるため）。`code` 内に改行が含まれるので一時ファイル経由で渡す:

```bash
HOOK=plugins/plan-rubocop-review/hooks/review-plan-rubocop.mjs
rm -f "${TMPDIR:-/tmp}/plan-rubocop-review-sessions.json"
RB='{"session_id":"t1","tool_input":{"plan":"```ruby\nclass A\nend\n```"}}'

# 1. ruby ブロックを含むプラン → deny（スキル実行指示を注入）
printf '%s' "$RB" | node "$HOOK"

# 2. マーカーあり → 即素通し（出力なし）
printf '%s' '{"session_id":"t3","tool_input":{"plan":"```ruby\nx\n```\n<!-- plan-rubocop-review: passed -->"}}' | node "$HOOK"

# 3. 上限到達（デフォルト2回）→ 3回目は素通し（出力なし）
printf '%s' "$RB" | node "$HOOK"
printf '%s' "$RB" | node "$HOOK"  # 出力なし

# 4. 異常入力 → 素通し（出力なし・exit 0）
echo 'not json' | node "$HOOK"

# 5. plan 不在 → 素通し（出力なし）
echo '{"session_id":"t1","tool_input":{}}' | node "$HOOK"

# 6. PLAN_RUBOCOP_REVIEW_MAX=0 → 常に素通し
PLAN_RUBOCOP_REVIEW_MAX=0 sh -c 'printf "%s" '"'$RB'"' | node '"$HOOK"

# 7. ruby ブロックなし（自然言語のみ）→ 早期スキップで素通し（出力なし）
printf '%s' '{"session_id":"t4","tool_input":{"plan":"just text, no code"}}' | node "$HOOK"

# 8. 他言語ブロックのみ → 早期スキップで素通し（出力なし）
printf '%s' '{"session_id":"t4","tool_input":{"plan":"```bash\necho hi\n```"}}' | node "$HOOK"
```

### RuboCop 検証ラッパの単体テスト

`.rubocop.yml` のある Ruby プロジェクトのルートで:

`code` には改行が含まれるため、`echo` でインラインに渡さず一時ファイル経由で渡します:

```bash
SCRIPT=plugins/plan-rubocop-review/skills/plan-rubocop-review-run/scripts/rubocop-stdin.mjs
cat > /tmp/blocks.json <<'JSON'
{"blocks":[{"path":"app/models/article.rb","code":"class Article\n  def foo\n    return 1\n  end\nend\n"}]}
JSON
cat /tmp/blocks.json | node "$SCRIPT"
# → rubocopAvailable / results / totalOffenses を含む JSON が返る
```

## 前提

- `node` が `PATH` 上にあること（フックとラッパスクリプトが Node.js）
- 検証先プロジェクトで `bundle exec rubocop` が利用可能で、`.rubocop.yml` が存在すること（無ければ検証はスキップされ素通しする）
- ラッパは RuboCop server mode（`--server`）で検証し、検証後に `--stop-server` でサーバを停止する。server mode は JRuby / Windows では利用できない（`fork` 非対応のため）

## 既知の制限

- **プランに Ruby コードブロックが書かれていなければ検証できません。** 「○○を追加する」のような自然言語のみのプランは検証対象外です。フックは `` ```ruby `` ブロックが無いプランを最初から素通しし（スキルも起動しません）、ブロックを含むプランではスキルが検証したブロック数・スキップしたブロック数を報告するため、「検証されていない」ことが分かるようになっています。
- フックの Ruby ブロック判定は軽量な正規表現で、言語タグが `ruby` / `rb` の明示フェンスのみを検出します。言語指定のないコードフェンス内の Ruby は検出されず素通しします（スキルの検証対象とも一致する仕様）。
- プラン段階のコードは実装の最終形と乖離しうる（プラン通りに実装されるとは限らない）ため、検証が通っても実装後に違反が出る可能性は残ります。
- コードブロックの配置パスは Claude 本体がプランの記述から推定します。`--stdin` に渡すパスは Include/Exclude・Cop 発火条件に使われるため、推定が不正確だと検証も不正確になります。推定できないブロックは検証がスキップされます。
- `--stdin` は 1 ファイルずつ評価するため、複数ファイル横断や周辺ファイル（`config/storage.yml` 等）に依存する Cop は完全には評価できません。
- 検証回数は `session_id` 単位で管理されるため、同一プランでも別セッションでは再度検証されます。
