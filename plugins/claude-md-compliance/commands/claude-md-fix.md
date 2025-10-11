---
description: プロジェクトのCLAUDE.mdガイドラインに照らして、ガイドラインに準拠していない箇所を自動的に修正します。
argument-hint: [ファイル名]
---

# CLAUDE.md コンプライアンス修正コマンド

このコマンドは、プロジェクトのCLAUDE.mdガイドラインに照らして、ガイドラインに準拠していない箇所を自動的に修正します。

## 実行手順

1. **ファイル指定**
   - コマンド実行時に引数として対象ファイル名を指定
   - 例: `/claude-md-fix app/controllers/users_controller.rb`

2. **ガイドライン取得**
   - `mcp__plugin_claude-md-compliance_find-agents-md__find_agents_md` を利用して適用されるガイドラインを取得

3. **コンプライアンスチェック**
   - 取得したガイドラインに基づいて違反箇所をチェック

4. **自動修正**
   - ガイドライン違反を検出した場合、自動的に修正を実施

5. **修正結果の報告**
   - 修正箇所と修正内容を明示
   - 修正不可能な箇所がある場合は警告を表示

## 使用例

```bash
# 単一ファイルのチェックと修正
/claude-md-fix app/models/user.rb

# コントローラーのチェックと修正
/claude-md-fix app/controllers/projects_controller.rb

# サービスクラスのチェックと修正
/claude-md-fix app/services/payment_processor.rb
```

## 注意事項

- ファイルを修正する前に、必ず現在の内容を確認
- 修正は可逆的に行い、重要な機能を壊さないよう注意
- テストファイルがある場合は、修正後にテストが通ることを確認
