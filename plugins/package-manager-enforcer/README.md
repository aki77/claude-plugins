# package-manager-enforcer

Node.js プロジェクトで、プロジェクトが使っているパッケージマネージャーと異なるコマンドを実行しようとした場合にブロックするプラグインです。

## 背景

`pnpm-lock.yaml` があるプロジェクトで Claude が `npm install` を叩く、といった「パッケージマネージャーの混在」はロックファイルの破壊や依存関係の不整合を招きます。このプラグインは `PreToolUse(Bash)` フックで Bash コマンドを事前に検査し、不一致を検出した場合に exit 2 でブロックします。

## しくみ

1. Claude が Bash コマンドを実行しようとすると `PreToolUse` フックが起動
2. `package-manager-enforcer.mjs` が stdin から JSON を受け取り、コマンド先頭語を抽出
3. `npm` / `yarn` / `pnpm` / `yarnpkg` / `pnpx` 以外のコマンドはスルー（exit 0）
4. `npx` は常に許可（ALWAYS_ALLOWED_COMMANDS）
5. `process.cwd()` から上に向かって `package.json` を探し、プロジェクトルートを特定
6. `package.json` の `packageManager` フィールド、またはロックファイル (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`) からパッケージマネージャーを推定
7. 実行コマンドと推定マネージャーが一致しない場合、エラーメッセージを出力して exit 2（ブロック）

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install package-manager-enforcer@aki77/claude-plugins
```

インストール後は Claude Code を再起動してください。

## 前提

- `node` が `PATH` 上にあること

## 既知の制限

- `process.cwd()` 起点で `package.json` を探すため、Claude Code の作業ディレクトリが Node.js プロジェクト外の場合は素通しになる
- monorepo でルートと子パッケージが異なるマネージャーを使うケースは考慮していない
- パイプやサブシェルを含む複合コマンド（`cd foo && npm install`）は先頭語のみ検査するため、後続の npm コマンドはチェックされない
