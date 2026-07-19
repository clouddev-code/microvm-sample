# HANDOFF

> このファイルはセッション引き継ぎ用。コンテキスト圧迫時に随時更新すること。
> 最終更新: 2026-07-12

## プロジェクト概要

S3 (`messages/*.txt`) → SQS → 常駐MicroVMワーカー（SQSロングポーリング）→ Bedrock Haiku 4.5で日本語解説生成 → DynamoDB登録、というプロトタイプ。
`AWS Lambda MicroVMs`（2026年6月発表のプレビュー機能、boto3サービス名 `lambda-microvms`）を初めて使う構成のため、実装より先にドキュメント調査（`research/`配下）を積み重ねている段階。**まだCDKコードの本格修正やデプロイ検証には入っていない。**

## 構成

- `cdk/` — CDK (TypeScript) スタック。`cdk/lib/s3-microvm-async-stack.ts` に `baseImageArn`/`baseImageVersion`/`egressNetworkConnectors` のプレースホルダーがあり、デプロイ前に実値へ置き換えが必要（README.md参照）。
- `microvm-worker/` — MicroVMイメージのアプリコード（Dockerfile + `app.py`）。SQSロングポーリング→Bedrock呼び出し→DynamoDB登録。
- `research/` — AWS公式ドキュメント裏取りメモ一式（下記参照）。
- `README.md` — デプロイ手順・重要な制約5点をまとめ済み。
- `TODO.md` — idle-suspend機構がSQSワーカーに効かない問題を記録。

## これまでに完了した調査（research/配下、事実ベース・参照URL付き）

1. `ai-lambda-microvms-api.md` — SuspendMicrovm API基本仕様、microvmId取得方法（`/run`フックのペイロード）、IAMアクション一覧
2. `ai-lambda-microvm-sqs-worker-execution-role-idle-policy.md` — executionRoleArn、IdlePolicyの3フィールド
3. `ai-lambda-microvms-iam-trust-policy-and-networking.md` — IAM信頼ポリシー・ネットワーク基礎
4. `ai-lambda-microvms-image-build-and-bedrock-haiku-invocation.md` — イメージビルド、Bedrock呼び出し
5. `ai-lambda-microvms-image-build-ready-hook-timeout.md` — Ready/Validateフックのタイムアウト原因切り分け
6. `ai-lambda-microvms-network-connector-egress-necessity.md` — egressネットワークコネクタの要否
7. `ai-lambda-microvms-s3-trigger.md` — **S3イベント通知はMicroVMを直接ターゲットにできない**（標準パターン: S3→通常Lambda→SDK経由でRunMicrovm）
8. `ai-lambda-vpc-dynamodb-bedrock-network-design.md` — VPCネットワーク設計
9. `ai-lambda-microvms-suspend-resume-lifecycle.md`（今回セッションで新規作成） — Suspend/Resume APIの正確な仕様、状態遷移表（`PENDING→RUNNING→SUSPENDING→SUSPENDED→(RUNNING|TERMINATING)→TERMINATED`）、IdlePolicy省略による自動サスペンド無効化が正式な方法であること、課金モデル（RUNNING=コンピュート課金、SUSPENDED=課金なし+スナップショット課金のみ、TERMINATED=課金なし）
10. `ai-lambda-microvms-self-suspend-and-sqs-trigger-feasibility.md`（今回セッションで新規作成） — 自己サスペンドの可否、ヘルスチェック専用フックの不在、SQSトリガー起動パターンの整合性

## 重要な決定事項・確定した仕様（今回セッションで判明した分）

- **ヘルスチェック専用フックは存在しない**。ランタイムのライフサイクルフックは `/run`・`/resume`・`/suspend`・`/terminate` の4種類のみ（+ビルド時の`/ready`・`/validate`）。
- **自動サスペンドを完全に無効化する正式な方法は「`RunMicrovm`呼び出し時に`idlePolicy`ブロック自体を省略すること」**（専用の`disabled`フラグは無い）。
- **MicroVM内部からの自己サスペンド（`SuspendMicrovm`を自分自身に対して呼ぶ）は、IAM・ネットワーク的にブロックする記載は無く技術的には可能と解釈できるが、公式Agent Skillに「No self-suspend from inside the MicroVM. Call from outside.」と明記されており、公式にサポートされた正規パターンではない**（非推奨・未検証）。
- **SQSはMicroVMを直接トリガーできない**。標準パターンは「SQS→仲介Lambda関数（イベントソースマッピング）→`GetMicrovm`で状態確認→`TERMINATED`/未起動なら`RunMicrovm`、`SUSPENDED`なら`ResumeMicrovm`」。ただしこの分岐ロジック自体を名指しで推奨する一次情報は無い。
  - 並行呼び出しの競合対策（`ConflictException`を握りつぶす、仲介Lambdaの予約済み同時実行数を1に制限する等）は公式ガイダンスなし。安全側の対処として自前で実装する必要がある。
  - `ResumeMicrovm`/`RunMicrovm`は非同期APIなのでfire-and-forgetでよい（完了を待つ必要なし）。

## 方針決定済み: idle-suspend対応（2026-07-12）

**候補B（`idlePolicy`省略＋外部からSuspendMicrovmを呼ぶ）を採用と決定。** 候補A（自己Suspend）は公式Agent Skillが明示的に非推奨としているため不採用・検証対象外。

決定の経緯: advisorツールが本セッションでも利用不可だったため、グローバルCLAUDE.mdのポリシーに従い `Agent(model="fable")` を判断用アドバイザーとして代用し相談。結論と実装方針は以下の通り（**まだ実装には着手していない**）。

1. 仲介Lambda（SQS→Run/Resume用に元々必須）にSuspend判断も集約し、EventBridge Schedulerで定期チェック（例: 5分毎に`ApproximateNumberOfMessages*`=0かつ最終処理から一定時間経過→`SuspendMicrovm`）を行う設計とする。
2. レース対策: Suspend実行直前に再度キュー深度を確認する。Suspend後にメッセージが着信した場合は、既存のResume経路（SQS→仲介Lambda→`GetMicrovm`で`SUSPENDED`検知→`ResumeMicrovm`）が救済する前提で冪等に設計する。
3. 8時間の`maximumDurationInSeconds`上限到達による強制terminateからの自動再起動経路（仲介Lambdaの`GetMicrovm`→`RunMicrovm`）が実際に機能することを、プロトタイプ実装後に必ず実機検証する。

## 未解決のTODO（次にやるべきこと）

1. **上記方針決定に基づき、仲介Lambda＋EventBridge Schedulerの実装**（未着手。設計方針のみ確定）
   - SQSイベントソースマッピングによるRun/Resume起動ロジック
   - EventBridge Schedulerによる定期Suspend判定ロジック
   - 上記2つの競合（同時Run/Resume/Suspend呼び出し）対策の実装
2. 8時間の`maximumDurationInSeconds`上限到達時の自動再起動の仕組み（未実装、`cdk/.claude/HANDOFF.md`にも同一課題が残っている可能性あり要確認）
3. `cdk/lib/s3-microvm-async-stack.ts`のプレースホルダー値（`baseImageArn`/`baseImageVersion`/`egressNetworkConnectors`）を実値に置き換え
4. MicroVM内部でのIAM認証情報取得方法の実機検証（IMDSv2経由でexecution role認証情報が取得できるかは今回の調査で文書上確認できたが、実機未検証）

## 次のセッションで最初に読むべきファイル

1. このHANDOFF.md（idle-suspend方針決定済み・実装未着手）
2. `research/ai-lambda-microvms-suspend-resume-lifecycle.md`
3. `TODO.md`
4. `README.md`（重要な制約5点）

## 備考

- AWS関連の調査は必ず `aws-researcher` サブエージェント経由で実施すること（グローバルCLAUDE.mdのルーティングルール）。
- advisorツールは2セッション連続で利用不可（"The advisor tool is unavailable"）。次回セッションでも利用不可な場合は、グローバルCLAUDE.mdの代替ポリシー通り `Agent(model="fable")` に文脈を明示的に渡して判断相談すること（本セッションではこの方式でidle-suspend方針を決定した）。
