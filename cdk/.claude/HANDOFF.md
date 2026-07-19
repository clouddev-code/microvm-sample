# S3MicrovmAsyncStack デプロイ作業状態（2026-07-05 14:53頃 JST時点・完全解決済み）

## 結論: エンドツーエンドで動作確認済み
S3アップロード → SQS → MicroVMワーカー → Bedrock Claude Haiku 4.5 → DynamoDB のパイプライン全体が
実機で正常動作することを確認した。

```
aws dynamodb scan --table-name s3-microvm-async-results --region us-west-2
```
→ `id`, `original_text`, `japanese_explanation`, `model_id`, `processed_at` を含むアイテムが
実際に登録されていることを確認済み（テストメッセージ: "Rome wasn't built in a day."）。

## 今回のセッションで解決した3つの問題（時系列順）

### 1. `/ready`フックタイムアウト（`Ready hook invocation timed out after PT5M`）
**根本原因**: フック用HTTPリスナーをアプリ本体と同じポート（8080）で共用していたこと。
公式ドキュメント・Agent Skillのサンプル実装は一貫してアプリ用ポートとフック専用ポート
（例: 9000）を別リスナー・別スレッドで起動しており、この分離構成が本プロジェクトでは
唯一検証されていなかった。

**修正**:
- `microvm-worker/app.py`: フックサーバーを`HOOKS_PORT`（デフォルト9000）で待ち受けるよう変更
- `microvm-worker/Dockerfile`: `EXPOSE 8080` → `EXPOSE 9000`
- `cdk/lib/s3-microvm-async-stack.ts`: `hooks.port: 8080` → `9000`、環境変数`PORT`→`HOOKS_PORT`

VPC/NetworkConnector構成、アプリコードの複雑さ、`readyTimeoutInSeconds`の長さ、
`baseImageVersion: '0'`はすべて原因ではなかった（`baseImageVersion: '0'`は
`list-managed-microvm-image-versions`で確認した結果、al2023-1の唯一かつ最新版で正しい値）。

### 2. SQS AccessDenied（`s3-microvm-async-build-role`、ユーザーが最初に報告した問題）
**根本原因**: boto3クライアント（`sqs`, `s3`, `bedrock`, `table`）をモジュール読み込み時
（コンテナ起動時点＝ビルド時の`/ready`フック実行時、buildRoleコンテキスト）に生成していたこと。
AWS Lambda MicroVMsはビルド時に取得したメモリスナップショットをそのまま実行時にレジュームする
方式のため、モジュールレベルで生成したboto3クライアントに紐づく認証情報解決の文脈が
buildRoleのまま固定され、実行時（`run-microvm`で指定した`executionRoleArn`）にレジュームしても
SQS等の権限がbuildRoleのままになっていた。

**修正**: `microvm-worker/app.py`で`sqs`/`s3`/`bedrock`/`table`をモジュールレベルで
`None`初期化し、`init_clients()`関数で実際に生成する処理に変更。`init_clients()`は
`ensure_poller_started()`内、つまり`/run`・`/resume`フック（executionRoleで呼ばれる）
発火後にのみ呼ばれるようにした。これにより、レジューム後に初めてboto3クライアントが
生成され、正しくexecutionRoleの認証情報を解決するようになった
（ログで`Found credentials from IAM Role: execution_role`を確認）。

### 3. Bedrock ValidationException（オンデマンドスループット非対応）
**根本原因**: `anthropic.claude-haiku-4-5-20251001-v1:0`をfoundation-model ARNとして
直接呼び出していたが、Claude Haiku 4.5はオンデマンドスループットに対応しておらず、
推論プロファイル経由の呼び出しが必須だった。

**修正**: `aws bedrock list-inference-profiles`で確認した
`us.anthropic.claude-haiku-4-5-20251001-v1:0`（クロスリージョン推論プロファイル）に変更。
IAMポリシーのresourcesも「推論プロファイルARN」＋「基盤モデルARN（リージョンワイルドカード）」
の両方を許可するよう修正した。

```typescript
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_UNDERLYING_FOUNDATION_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
...
resources: [
  `arn:aws:bedrock:${region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
  `arn:aws:bedrock:*::foundation-model/${BEDROCK_UNDERLYING_FOUNDATION_MODEL_ID}`,
],
```

## 現在デプロイされている状態
- `MicrovmImageArn`: `arn:aws:lambda:us-west-2:905860205176:microvm-image:s3-microvm-async-worker`
  （imageVersion: `3.0`、上記3つの修正すべて反映済み）
- 実行中のMicroVM: `microvm-964704ad-27cc-39f0-a8ed-586ee1405a28`（`RUNNING`、
  `maxIdleDurationSeconds: 28000`, `maximumDurationInSeconds: 28800`）
- テストメッセージ`messages/message1.txt`の処理結果がDynamoDBに1件登録済み。

## 残タスク・今後の検討事項
1. **MicroVMの最大稼働時間は8時間**。8時間ごとの自動再起動の仕組み（EventBridge Scheduler等での
   `run-microvm`/`resume-microvm`再実行）は未実装（README.md「未実装・今後の検討事項」参照）。
2. `microvm-worker/README.md`が存在しないため、プロジェクトルートの`README.md`に今回の教訓
   （フック用ポート分離必須、boto3クライアント遅延生成必須、Bedrock推論プロファイル必須）を
   反映するとよい。まだ未実施。
3. `research/`配下の調査ファイルのうち、VPC関連・`baseImageArn`関連など今回の根本原因究明で
   否定された仮説を含むものは、「否定済みの仮説」として整理するとよい。
4. 動作確認用に作成したテストデータ（S3オブジェクト`messages/message1.txt`、DynamoDBの
   該当アイテム）はプロトタイプ検証用。本格運用前にクリーンアップを検討。
5. SQS DLQ（`UploadDlq`）に溜まったメッセージの再処理フローは未実装。

## 得られた教訓（今回新たに確定したもの、AWS Lambda MicroVMsプレビュー機能特有の罠）
- **フックを使う場合、フック用ポートはアプリ本体のポートと必ず分離すること。** 公式サンプルは
  例外なく分離しており、同一ポート共用は未検証の構成だった。
- **boto3クライアント（および他の認証情報を内部にキャッシュするSDKオブジェクト全般）は
  モジュール読み込み時に生成してはいけない。** MicroVMsはビルド時（buildRole）のプロセス
  スナップショットをそのまま実行時（executionRole）にレジュームするため、モジュールレベルで
  生成したクライアントは古いロールの認証情報解決コンテキストを引きずる。
  **必ず`/run`・`/resume`フック発火後（実行ロールでの起動が確定した後）に遅延生成すること。**
- Claude Haiku 4.5のようにオンデマンドスループット非対応のモデルは、`bedrock:InvokeModel`の
  `modelId`に推論プロファイルID（`list-inference-profiles`で確認）を渡す必要があり、IAMポリシーも
  推論プロファイルARN＋基盤モデルARNの両方に対する許可が必要。
- `list-microvm-image-builds`の`stateReason`は最も速く正確な一次情報源（CFNイベント伝播より先行）。
- CFNスタックが`ROLLBACK_COMPLETE`のときはupdateできないため削除してから再作成する必要がある
  （プロトタイプ環境でユーザー承認を得て実施）。
- CDK L1コンストラクト（`CfnMicrovmImage`）は`baseImageVersion`を必須プロパティとしているが、
  boto3の生APIドキュメントでは省略可（省略時は最新版）と説明されている。矛盾がある場合はCDK側の
  型定義（＝CFNリソーススキーマ）の制約が優先される。
