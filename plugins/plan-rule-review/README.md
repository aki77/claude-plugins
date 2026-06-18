# plan-rule-review

Plan Mode 終了時（`ExitPlanMode`）に、プランがプロジェクトルールに準拠しているかを Claude 本体にレビューさせるプラグインです。

## 背景

Claude Code の Plan Mode は実装前にプランを確認できる便利な仕組みですが、プランを承認するのはユーザー自身しかおらず、プロジェクトルール（`CLAUDE.md` / `.claude/rules/`）への準拠漏れが見落とされやすいという問題があります。

このプラグインは `ExitPlanMode` を `PreToolUse` フックで捕捉し、プランがプロジェクトルールに違反していないかを Claude 自身にレビューさせます。違反があればプランを修正させてから実装に進ませることで、実装着手前にルール準拠を担保します。

レビュー観点は **プロジェクトルール準拠チェックのみ** です（バグ・一般的なコード品質・スタイルは対象外）。

## しくみ

`PreToolUse(ExitPlanMode)` フックが以下の流れで動作します：

1. Claude がプランを書き `ExitPlanMode` を呼ぶ → フックが発火する
2. プランに「レビュー済み・違反なし」を示すマーカー（`<!-- plan-rule-review: passed -->`）が含まれていれば、フックは即座に素通し（`ExitPlanMode` を許可）する
3. マーカーがなく、セッションあたりのレビュー回数が上限未満なら、`ExitPlanMode` を deny（拒否）し、レビュー指示を Claude の context に注入する
4. Claude 本体は指示に従い、レビュー専用のサブエージェント（general-purpose）を Task ツールで 1 つ起動する。サブエージェントが `CLAUDE.md` と `.claude/rules/` を読み込んでプランのルール準拠を判定し、結果（`VERDICT: PASS` または `VERDICT: FAIL` ＋違反リスト）をテキストで本体に返す
5. サブエージェントが違反ありを返したら、本体がプランを修正し（マーカーは付けずに）、再度 `ExitPlanMode` を呼ぶ
6. サブエージェントが `VERDICT: PASS` を返したときのみ、本体がプラン末尾にマーカーを追記して `ExitPlanMode` を呼ぶ → ステップ 2 で即座に許可される（違反のないプランは 1 回のレビューで通過する）
7. マーカーが付かないままレビュー回数が上限に到達すると、フックは素通し（`ExitPlanMode` を許可）し、無限ループを防ぐ

レビュー判断は、プランを書いた本体とは独立した文脈のサブエージェントに委譲します。これにより、本体が自分の書いたプランを甘く自己レビューしてしまうバイアスを軽減します。サブエージェントへの指示では、ルートおよび祖先ディレクトリの `CLAUDE.md`、`.claude/rules/` 配下のルール（`paths` 未指定の全適用ルール＋プランの変更対象に `paths` が一致するルール）を読み込んで違反のみを指摘するよう依頼します。どのルールが該当するかの判断はサブエージェントに委譲します。本体はサブエージェントの `VERDICT: PASS` 判定を受け取ったときのみマーカーを転記します。

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install plan-rule-review@plugin-hub
```

インストール後は Claude Code を再起動してください（フックは再起動後のセッションから有効になります）。

## 設定

| 環境変数 | 説明 | デフォルト |
| --- | --- | --- |
| `PLAN_RULE_REVIEW_MAX` | セッションあたりの最大レビュー回数（マーカーが付かないまま繰り返された場合の無限ループ防止上限） | `2` |

通常は違反のないプランにマーカーが付くことで 1 回のレビューで通過するため、`PLAN_RULE_REVIEW_MAX` は「マーカーが付かないまま `ExitPlanMode` が繰り返された場合」のセーフティネットとして機能します。

`0` を指定するとレビューを無効化できます（常に `ExitPlanMode` を許可）。

レビュー回数はセッション単位（`session_id`）で `${TMPDIR}/plan-rule-review-sessions.json` に記録されます。24 時間以上古いエントリは自動的にクリーンアップされます。

## 動作確認

Plan Mode でプランを作成し `ExitPlanMode` を呼ぶと、レビュー指示が注入されてプランが一旦ブロックされること、`PLAN_RULE_REVIEW_MAX` 回のレビュー後に通過することを確認します。

### フックスクリプトの単体テスト

```bash
HOOK=plugins/plan-rule-review/hooks/review-plan.mjs
rm -f "${TMPDIR:-/tmp}/plan-rule-review-sessions.json"

# 1. 正常なプラン → deny（レビュー指示を注入）
echo '{"session_id":"test1","tool_input":{"plan":"some plan"}}' | node "$HOOK"

# 1b. マーカーあり → 即素通し（出力なし）。count に関係なく通過する
echo '{"session_id":"test3","tool_input":{"plan":"some plan\n<!-- plan-rule-review: passed -->"}}' | node "$HOOK"

# 2. 上限到達（デフォルト2回）→ 3回目は素通し（出力なし）
echo '{"session_id":"test1","tool_input":{"plan":"some plan"}}' | node "$HOOK"
echo '{"session_id":"test1","tool_input":{"plan":"some plan"}}' | node "$HOOK"  # 出力なし

# 3. 異常入力 → 素通し（出力なし・exit 0）
echo 'not json' | node "$HOOK"

# 4. plan 不在 → 素通し（出力なし）
echo '{"session_id":"test1","tool_input":{}}' | node "$HOOK"

# 5. PLAN_RULE_REVIEW_MAX=0 → 常に素通し
PLAN_RULE_REVIEW_MAX=0 sh -c 'echo "{\"session_id\":\"test2\",\"tool_input\":{\"plan\":\"p\"}}" | node '"$HOOK"
```

## 前提

- `node` v18+ が `PATH` 上にあること

## 既知の制限

- レビューの質はサブエージェントに依存する（フックはレビュー指示の注入とレビュー回数の管理のみを行う）
- 違反なしを示すマーカーは本体が付けるが、その判断はレビュー専用サブエージェントの `VERDICT: PASS` 判定に基づくよう指示しており、プラン作成者自身による甘い自己レビューのバイアスは軽減される。ただし担保は指示文の規律のみで、機械的検証（nonce 等）は行っていないため、本体がサブエージェントの判定を無視してマーカーを付ける可能性は理論上残る
- レビュー回数は `session_id` 単位で管理されるため、同一プランでも別セッションでは再度レビューされる
- プランの変更対象ファイルが未確定な段階のため、`.claude/rules/` の `paths` による該当判定は Claude 本体の判断に委ねている
