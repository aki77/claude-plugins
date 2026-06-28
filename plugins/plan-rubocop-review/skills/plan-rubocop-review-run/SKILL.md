---
name: plan-rubocop-review-run
description: "plan-rubocop-review フック専用。手動・自動を問わずこのスキル名で明示起動されたときのみ実行する。"
allowed-tools: Bash
user-invocable: false
---

Plan Mode のプラン本文に含まれる **Ruby コードブロック** を、実装着手前に RuboCop（プロジェクトの `.rubocop.yml` 準拠）で検証します。

検証対象は **プランに実際に書かれた ` ```ruby ` コードブロックのみ** です。コードブロックが無いプラン、配置パスが特定できないコードブロックは検証できません。「検証された」という偽の安心感を避けるため、**最後に必ず「検証したブロック数・スキップしたブロック数・違反件数」をユーザーに報告**してください。

**前提:**
- すべてのツールは正常に動作する前提で使うこと。動作確認のための試し打ちはしない。
- 検証先プロジェクトで `bundle exec rubocop` は **使える前提** でよい。事前に `--version` 等で存在確認する必要はない（万一使えなければラッパが `rubocopAvailable: false` を返すので、その分岐で素通しする）。
- ファイルは一切作成・変更しない。検証は `--stdin` でメモリ上で行う。

検証対象のプラン全文は、このスキルを起動した指示（フックの reason）の中の `<<<PLAN` と `PLAN` で囲まれたブロックに含まれている。この区切りの間にあるテキストをプラン全文として扱う。

## 手順1: Ruby コードブロックと配置パスを抽出する

プラン全文から ` ```ruby ` ～ ` ``` ` で囲まれた Ruby コードブロックをすべて列挙する。各ブロックについて、**そのコードの本来の配置パス**（リポジトリルート相対）を推定する:

- コードブロック直前の見出し・文から推定する。例:
  - 「`app/models/article.rb` を以下のように作成する」→ `app/models/article.rb`
  - 「### `spec/models/article_spec.rb`」→ `spec/models/article_spec.rb`
- パスは RuboCop の Include/Exclude・Cop 発火条件に使われるため、**本来の配置パスを正確に**推定すること。曖昧なら配置されるディレクトリの慣例（`app/models/`, `app/controllers/`, `spec/` 等）から補う。
- **「実装時に決定」「TBD」「未定」などの明示的不確定ワードが直前にある場合は、モジュール・クラス名からの慣例パス推定を試みずスキップする。**
- **どうしても配置パスが特定できないブロックは検証をスキップ**し、スキップしたことを記録する（後でユーザーに報告する）。
- ` ```ruby ` 以外の言語ブロック（`bash`, `yaml`, `json` 等）、言語指定のないブロックは対象外。

検証対象ブロックが 1 つも無ければ手順4へ（PASS 扱い）。

## 手順2: RuboCop で検証する

検証先プロジェクトのルート（`.rubocop.yml` がある場所＝通常はカレントディレクトリ）で、抽出したブロックを次の補助スクリプトに渡す。**stdin 経由で JSON を渡す**こと（コードに改行・特殊文字が含まれるため引数では渡さない）。

`echo` でインラインに渡すとコード中の改行・クオートが壊れやすいため、**いったん JSON ファイルを書いてから `cat` で渡す**こと:

```bash
# 1. blocks JSON を一時ファイルに書く（code には実際の Ruby ソースを改行込みで入れる）
cat > /tmp/plan-rubocop-blocks.json <<'JSON'
{
  "blocks": [
    { "path": "app/models/article.rb", "code": "class Article < ApplicationRecord\n  validates :title, presence: true\nend\n" }
  ]
}
JSON

# 2. 検証先プロジェクトのルートで実行する
cat /tmp/plan-rubocop-blocks.json | node ${CLAUDE_PLUGIN_ROOT}/skills/plan-rubocop-review-run/scripts/rubocop-stdin.mjs
```

`code` フィールドには Ruby ソースを正しい改行・インデントで入れること（JSON 文字列としてエスケープする）。`path` はそのコードの本来の配置パス。

スクリプトは各ブロックを `bundle exec rubocop --server --stdin <path> --format json --force-exclusion` で検証する。`--server` により初回呼び出しで RuboCop サーバが起動・常駐し、2 ブロック目以降はそれを使い回してブート時間を削減する。全ブロック検証後にスクリプトが `--stop-server` でサーバを停止するため、常駐プロセスは残らない。検証結果は次の JSON で返る:

- `rubocopAvailable: false` → このプロジェクトで `bundle exec rubocop` が使えない、または入力不正。**検証不能** として手順4へ（PASS 扱い・マーカー付与）。その旨をユーザーに報告する。
- `rubocopAvailable: true` → `results` に各ブロックの `offenseCount` と `offenses`（`cop` / `message` / `line` / `severity` / `correctable`）が入る。`totalOffenses` が総違反数。

## 手順3: 判定と再 ExitPlanMode

- `totalOffenses === 0`（全ブロック違反なし、またはスキップのみ） → 手順4（PASS）へ。
- `totalOffenses > 0`（違反あり） → プラン内の**該当 Ruby コードブロックを RuboCop 指摘（`cop` / `message` / `line`）に沿って修正**する。`correctable: true` の Cop は autocorrect 相当の修正を施す。修正後、**マーカーは付けずに** `ExitPlanMode` を呼ぶ（再びフックが発火し、修正後のコードが再検証される）。

## 手順4: PASS 時のマーカー付与と ExitPlanMode

プラン本文の末尾に次の 1 行を追記してから `ExitPlanMode` を呼ぶ:

```
<!-- plan-rubocop-review: passed -->
```

このマーカーがあると以降このプラグインの検証はスキップされ、即座に承認へ進む。

## 手順5: ユーザーへの報告（必須）

`ExitPlanMode` の前後で、次を必ずユーザーに伝える:

- 検証した Ruby コードブロック数
- 配置パス不明等でスキップしたブロック数（あれば）
- 検出した違反件数と、修正した場合はその概要
- RuboCop が使えず検証できなかった場合はその旨

これは「Ruby を含むプランは必ず RuboCop 検証された」という誤解を防ぐため。プランにコードブロックが無い／パス不明でスキップした場合は、**「検証していない」ことを明示**する。

### 厳守事項

- マーカー `<!-- plan-rubocop-review: passed -->` を付けるのは、`totalOffenses === 0` または検証不能（`rubocopAvailable: false`）・検証対象ブロックなし のときのみ。違反が残っている状態で付けない。
- ファイルを作成・変更して検証してはならない。必ず `--stdin` で検証する。
- 検証対象は ` ```ruby ` ブロックのみ。プラン本文の自然言語記述から Ruby コードを「想像して」検証してはならない（書かれていないコードは検証対象外）。
- 配置パスは推定だが、推定できないブロックは検証をスキップする（誤ったパスで検証すると Include/Exclude が誤って効き、検証が無意味になる）。
