# HANDOFF

> このファイルはセッション引き継ぎ用。コンテキスト圧迫時に随時更新すること。
> 最終更新: 2026-07-20 12:50頃 JST — **`SyncHelloWorldStack`のデプロイ〜動作確認一式は完了。**
> 詳細は本ファイル末尾の追記、および`microvm-sync-app/.claude/HANDOFF.md`参照。
> **⚠️ 現在、8時間suspend後の強制terminate検証のためMicroVMを起動中（下記「進行中の検証」参照）。
> 次回セッション開始時、まずこの確認を行うこと。**

## 進行中の検証: SUSPENDED状態が8時間続いた場合に強制terminateされるか（未確認・要手動チェック）

- **目的**: `suspendedDurationSeconds`（SUSPENDED状態のまま存在できる最大時間、超過で自動Terminate）
  および`maximumDurationInSeconds`（MicroVM全体の最大稼働時間、8時間）が、実際にSUSPENDED状態の
  MicroVMを強制terminateするかを実機確認する（`research/ai-lambda-microvms-suspend-resume-lifecycle.md`
  記載の状態遷移表は仕様上の記述であり、実機未検証だった）。
- **起動したMicroVM**: `microvm-befc4351-4fdd-31a0-9806-2b703155b1bf`
  （`SyncHelloWorldStack`のイメージ`sync-hello-world-app`を使用、リージョン`us-west-2`）。
  - `startedAt`: `2026-07-20T12:44:31+09:00`（JST）
  - `idlePolicy`: `{"autoResumeEnabled":true,"maxIdleDurationSeconds":60,"suspendedDurationSeconds":28800}`
  - `maximumDurationInSeconds`: `28800`（8時間）
  - 起動から約68秒後（12:45:39頃）に`SUSPENDED`への遷移を確認済み。以降は意図的に一切
    トラフィックを送っていない（`get-microvm`での状態確認はエンドポイントへのトラフィックに
    該当しないため、自動再開の原因にはならない）。
- **期待される強制terminate時刻**: 起動（`startedAt`）から8時間後 ≒ **2026-07-20 20:44:31 JST頃**
  （`maximumDurationInSeconds`が起点。`suspendedDurationSeconds`はSUSPENDED突入時点＝12:45:39から
  8時間後の20:45:39頃が起点になるため、両者はほぼ同時刻で、通常は`maximumDurationInSeconds`の方が
  わずかに先に発火すると想定される）。
  余裕を見て**21:00 JST以降**に確認するのが望ましい。
- **確認コマンド**（fish shell、`source ~/.nvm/nvm.sh; nvm use 22.22.2`は不要、AWS CLIのみでOK）:
  ```fish
  aws lambda-microvms get-microvm --microvm-identifier microvm-befc4351-4fdd-31a0-9806-2b703155b1bf --region us-west-2
  ```
  `state`が`TERMINATING`または`TERMINATED`になっていれば検証成功（8時間後に強制terminateされる
  ことが実機確認できたことになる）。もし21:00 JSTを過ぎてもまだ`SUSPENDED`のままであれば、
  「SUSPENDED状態は8時間を超えても自動terminateされない」という、ドキュメントの記述と異なる
  実機挙動である可能性が高く、追加調査が必要（`research/`配下に新規調査メモを作成すること）。
- **なぜスケジュール未設定か**: クラウドルーティン（`schedule`スキル経由）はAWS認証情報に
  アクセスできない独立クラウド環境で動作するため、`aws lambda-microvms get-microvm`が実行できず
  不採用。`CronCreate`（ローカルセッション内ジョブ）は8時間セッションが継続する保証がないため
  こちらも不採用。ユーザーの意向により、次回セッション開始時に手動で確認する方針とした。
- **後片付け**: 検証完了（`TERMINATED`確認、または「terminateされない」という結果が判明）後は、
  もしMicroVMがまだ生存していれば`aws lambda-microvms terminate-microvm --microvm-identifier
  microvm-befc4351-4fdd-31a0-9806-2b703155b1bf --region us-west-2`で終了させること。

## プロジェクト概要

`AWS Lambda MicroVMs`（2026年6月発表のプレビュー機能、boto3サービス名 `lambda-microvms`）の
プロトタイプ。現在2つのCDK Stackで構成される（`cdk/bin/app.ts`で並列インスタンス化、
Stack間参照ゼロで完全独立）。

1. **`S3MicrovmAsyncStack`**（`cdk/lib/s3-microvm-async-stack.ts`） — S3(`messages/*.txt`)→SQS→
   常駐MicroVMワーカー（SQSロングポーリング）→Bedrock Haiku 4.5→DynamoDB登録。
   **実機デプロイ済み・動作確認済み**（2026-07-05、詳細は`cdk/.claude/HANDOFF.md`）。
2. **`SyncHelloWorldStack`**（`cdk/lib/sync-hello-world-stack.ts`、**今回セッションで新規作成**） —
   HTTPエンドポイントに同期応答するFlask hello world PoC。着信HTTPトラフィックが無い
   常駐SQSワーカーとは対照的に、idle-suspend機構が実際に機能する対比デモという位置づけ。
   **実機デプロイ作業中**（下記「進行中の作業」参照。詳細は`microvm-sync-app/.claude/HANDOFF.md`）。

## 構成

- `cdk/` — CDK (TypeScript)。上記2 Stack。
- `microvm-worker/` — 常駐SQSワーカーのアプリコード（Dockerfile + Python、pip）。
- `microvm-sync-app/` — 同期Hello World PoCのアプリコード（Dockerfile + Python、**uv**でパッケージ管理）。
- `research/` — AWS公式ドキュメント裏取りメモ一式（下記参照）。
- `README.md` — 両Stackのデプロイ手順・重要な制約・「実機デプロイで判明した罠」4件をまとめ済み。
- `TODO.md` — idle-suspend機構が常駐SQSワーカーに効かない問題（未解決、方針決定済み・実装未着手）。

## これまでに完了した調査（research/配下、事実ベース・参照URL付き）

1. `ai-lambda-microvms-api.md` — SuspendMicrovm API基本仕様、IAMアクション一覧
2. `ai-lambda-microvm-sqs-worker-execution-role-idle-policy.md` — executionRoleArn、IdlePolicyの3フィールド
3. `ai-lambda-microvms-iam-trust-policy-and-networking.md` — IAM信頼ポリシー・ネットワーク基礎
4. `ai-lambda-microvms-image-build-and-bedrock-haiku-invocation.md` — イメージビルド、Bedrock呼び出し
5. `ai-lambda-microvms-image-build-ready-hook-timeout.md` — Ready/Validateフックのタイムアウト原因切り分け
6. `ai-lambda-microvms-network-connector-egress-necessity.md` / `-types.md` — Network Connectorの要否・種類
7. `ai-lambda-microvms-s3-trigger.md` — S3イベント通知はMicroVMを直接ターゲットにできない
8. `ai-lambda-vpc-dynamodb-bedrock-network-design.md` — VPCネットワーク設計
9. `ai-lambda-microvms-suspend-resume-lifecycle.md` — Suspend/Resume APIの正確な仕様、状態遷移表
10. `ai-lambda-microvms-self-suspend-and-sqs-trigger-feasibility.md` — 自己サスペンドの可否
11. `ai-lambda-microvms-terminated-endpoint-behavior.md`（前回セッション新規） — TERMINATED後は
    auto-resumeが復活させない、再開には明示的な`RunMicrovm`が必要
12. `ai-lambda-microvms-vs-agentcore-browser-code-interpreter.md` / `-vs-lambda-quota-comparison.md`
13. `ai-lambda-microvms-http-endpoint-auth.md`（今回セッション新規） — HTTPエンドポイントへの
    正しいアクセス方法（`X-aws-proxy-auth`/`X-aws-proxy-port`ヘッダー、`create-microvm-auth-token`
    レスポンス構造）

## 重要な決定事項・確定した仕様

- ヘルスチェック専用フックは存在しない（`/run`・`/resume`・`/suspend`・`/terminate`+ビルド時`/ready`・`/validate`のみ）。
- 自動サスペンド無効化の正式な方法は`idlePolicy`ブロック自体を省略すること。
- MicroVM内部からの自己サスペンドは非推奨（公式Agent Skill「No self-suspend from inside the MicroVM」）。
- SQSはMicroVMを直接トリガーできない（仲介Lambda必須、標準パターンあり）。
- **TERMINATED状態からの自動復帰は無い**（auto-resumeはSUSPENDED専用）。再開には呼び出し元が
  明示的に`RunMicrovm`を再実行する必要がある（新しいmicrovmId・新しいエンドポイントが発行される）。
- **HTTPエンドポイントへの正しいアクセス方法**（今回セッションで確定）: `get-microvm`の`endpoint`は
  ホスト名のみ（常にHTTPS）。ポート指定は`X-aws-proxy-port`ヘッダー、認証は
  `Authorization: Bearer`ではなく`X-aws-proxy-auth`ヘッダー。`create-microvm-auth-token`の
  レスポンスはトップレベルの`token`ではなく`authToken."X-aws-proxy-auth"`にJWE文字列が入る。
- `run-microvm`の`--image-identifier`はイメージ名だけでは`Malformed ARN`で拒否される。フルARNが必要。

## 今回セッションでの作業: SyncHelloWorldStack新規作成〜デプロイトラブル対応

### 完了事項
- `microvm-sync-app/`一式作成（Flask hello world、フック用ポート9000とアプリ用ポート8080を分離、
  `/run`・`/resume`でFlaskを別スレッド起動）。ローカルDocker検証は成功済み。
- `cdk/lib/sync-hello-world-stack.ts`新規作成、`cdk/bin/app.ts`に並列追加。`cdk synth`/`cdk list`で
  両Stack共存を確認済み。
- パッケージ管理は**uv**（ユーザー指示）。`pyproject.toml` + `uv.lock`。
- アーキテクチャ判断はadvisor不可のため`Agent(model="fable")`で承認済み（同一App内別Stack可、
  `ALL_INGRESS`条件付き可、Flask threading方式推奨、`maxIdleDurationSeconds`短め推奨→60秒に設定）。

### 発生したトラブルと対応（詳細は`microvm-sync-app/.claude/HANDOFF.md`）
1. 初版Dockerfileが`COPY --from=ghcr.io/astral-sh/uv:latest ...`でuvバイナリ取得 →
   **AWS側のMicroVMイメージビルド環境がghcr.ioに到達できない疑い**でビルドが30分以上ハング
   （`buildState: IN_PROGRESS`のまま変化なし、対応するCloudWatch Logsロググループも作成されない）。
   CFNスタックが`ROLLBACK_FAILED`/`DELETE_FAILED`に陥った（`IN_PROGRESS`中のビルドをキャンセル
   するAPIが存在しないため）。
2. ユーザーが手動でCFNスタックを削除完了（**確認済み、`SyncHelloWorldStack`・イメージとも消滅済み**）。
3. Dockerfileを修正: `ghcr.io`をやめ、`python3.13 -m pip install uv`（PyPI経由、既存ワーカーで
   疎通実績あり）でuv本体を取得する方式に変更。ローカル`docker build --no-cache`で再検証済み・成功。
4. ユーザーから別のuv Dockerfile例が提示されたが、(a)やはり`ghcr.io`を使っている、
   (b)ベースイメージが`python:3.13.13-slim-bookworm`（AWS Lambda MicroVMs必須の
   `public.ecr.aws/lambda/microvms:al2023-minimal`ではない）という2点で不採用と回答済み。

### 進行中の作業（このHANDOFF更新時点、12:26頃）
- 修正済みDockerfileで`npx cdk deploy SyncHelloWorldStack --require-approval never`を
  バックグラウンド実行中（タスクID: `bsh2rkzeb`、出力: `.../tasks/bsh2rkzeb.output`）。
  まだ出力が空（=cdk/npmの起動〜アセットアップロード段階と推定）。
- 並行して、CloudWatch Logsロググループ`/aws/lambda-microvms/sync-hello-world-app`の出現を
  30秒間隔・最大10分ポーリングするバックグラウンドジョブも実行中（タスクID: `bo7yhaj1o`、
  出力: `.../tasks/bo7yhaj1o.output`）。前回は正常ビルド時に即座に作成されたロググループが、
  ハング時には全く作成されなかったため、**このロググループが速やかに現れるかどうかが
  「ghcr.io仮説」の検証シグナル**になる。12:26:24時点ではまだ`[]`（未出現）。

## 追記（12:30頃）: デプロイ成功、ghcr.io仮説確認、新たな課題（エンドポイント認証）

- 修正版Dockerfile（PyPI経由uv取得）で`SyncHelloWorldStack`再デプロイ→**約2.5分でCREATE_COMPLETE**
  （前回30分超ハングと対照的）。ghcr.io到達不可仮説は強く裏付けられた。
- `run-microvm`実行、MicroVMは`RUNNING`まで到達。しかしエンドポイントへの`curl`が
  `403 Request missing authentication`→`create-microvm-auth-token`でトークン取得後も
  ポート指定方法が不明でタイムアウト。**MicroVMエンドポイントへの正しいアクセス方法
  （ポート指定ヘッダー、トークンの渡し方）が次回セッションの最優先課題**
  （詳細は`microvm-sync-app/.claude/HANDOFF.md`「追記」参照）。
- 動作確認未完のまま、時間の都合でMicroVMは`terminate-microvm`済み（確認済み）。
- idle-suspend自体の実機確認はまだ未実施。

## 追記（2026-07-20 13:05頃）: SyncHelloWorldStack完了

- バックグラウンドジョブ（`bsh2rkzeb`＝deploy、`bo7yhaj1o`＝ロググループ監視）は完了確認済み。
  `SyncHelloWorldStack`は`CREATE_COMPLETE`、ロググループもビルド開始から約2.5分で出現
  （＝「ghcr.io仮説」は確定とみなせる水準で裏付けられた）。
- `aws-researcher`エージェントでHTTPエンドポイントの正しいアクセス方法を調査・確定
  （`research/ai-lambda-microvms-http-endpoint-auth.md`、本ファイル冒頭「重要な決定事項」参照）。
- 新規`run-microvm`（`microvm-ca0911d6-e03e-3e88-85ca-c7d3f32f68bd`）→
  `X-aws-proxy-auth`/`X-aws-proxy-port`ヘッダー付きcurlで**Hello World応答を確認（200 OK）**→
  75秒無通信待機で**`SUSPENDED`遷移を確認**→再curlで**約1.1秒でauto-resume・`RUNNING`復帰・
  Hello World応答を再確認**→`terminate-microvm`で後片付け完了。**idle-suspend機構の一連の
  動作を実機で完全に確認できた。**
- `README.md`更新済み: 罠4番目（ghcr.io仮説）を確定トーン化、罠5番目（`--image-identifier`は
  フルARN必須）・6番目（`X-aws-proxy-*`ヘッダー）を新規追加。`run-microvm`コマンド例・
  動作確認セクションのcurl例も修正済み。
- `microvm-sync-app/.claude/HANDOFF.md`にも完了ステータス追記済み。

**`SyncHelloWorldStack`関連のタスクはこれで一区切り。** 次回セッションで着手すべきは
下記「次にやるべきこと」の通り、既存`S3MicrovmAsyncStack`側の継続課題のみ。

## 次にやるべきこと

1. （継続課題）`TODO.md`のidle-suspend対応（仲介Lambda＋EventBridge Scheduler）、
   8時間強制terminate後の自動再起動の仕組み — いずれも既存の`S3MicrovmAsyncStack`側の
   未解決課題。今回`SyncHelloWorldStack`でidle-suspend自体は正常動作を確認できたため、
   常駐SQSワーカー側で効かないのはアプリの通信パターン（着信HTTPが無い）に起因すると
   考えてよい。対応方針は`TODO.md`参照。
2. その他は特になし（`SyncHelloWorldStack`は動作確認まで完了、MicroVMインスタンスは
   `terminate-microvm`済みで課金リソースは残っていない）。

## 備考

- AWS CLIのデフォルトリージョンは`us-west-2`（アカウント`905860205176`）。`cdk/bin/app.ts`の
  フォールバック値`ap-northeast-1`は使われていない（`CDK_DEFAULT_REGION`未設定時はAWS CLI設定に従う）。
- Node実行には`source ~/.nvm/nvm.sh; nvm use 22.22.2`が必要（`node`/`npm`がデフォルトPATHに無い）。
- advisorツールは今セッション中「temporarily disabled」。CLAUDE.mdの代替ポリシー通り
  `Agent(model="fable")`を使うこと。
- AWS関連の調査は`aws-researcher`サブエージェント経由が原則だが、今回のデプロイトラブル対応は
  実機のAWS CLI操作（`aws lambda-microvms`/`aws cloudformation`直接実行）で行った
  （research以外の実オペレーションのため）。
