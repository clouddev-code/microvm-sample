# S3 → MicroVM → Bedrock Haiku 4.5 → DynamoDB プロトタイプ

S3の`messages/`配下に英語メッセージ（テキストファイル）をアップロードすると、
SQS経由でAWS Lambda MicroVMの常駐ワーカーが検知し、Bedrock Claude Haiku 4.5で
日本語解説を生成してDynamoDBに登録するプロトタイプです。

```
S3 (messages/*.txt) → SQS Queue（ネイティブ連携）→ 常駐MicroVMワーカー
                                                      ├─ S3から本文取得
                                                      ├─ Bedrock Haiku 4.5で日本語解説生成
                                                      └─ DynamoDBへ登録
```

設計の詳細・技術的な裏付けは `design-s3-microvm-async-prototype.md` と
`research/` 配下の各調査ログを参照してください。

## 構成

- `cdk/` — AWS CDK (TypeScript) スタック。S3・SQS・DynamoDB・IAMロール・MicroVMイメージ定義を宣言的に管理。
- `microvm-worker/` — MicroVMイメージのアプリケーションコード（Dockerfile + Python）。SQSをロングポーリングし、Bedrock呼び出し・DynamoDB登録を行う。

## 重要な制約（デプロイ前に必ず確認）

AWS Lambda MicroVMsは非常に新しい機能のため、以下はドキュメント調査に基づく設計ですが、
**実機での検証が必須**です。

1. **`baseImageArn` / `baseImageVersion`（`cdk/lib/s3-microvm-async-stack.ts`内`TODO`参照）**
   現時点でプレースホルダー値（`al2023-1` / `1`）を設定しています。デプロイ前に
   `aws lambda-microvms list-microvm-images`（または公式ドキュメント）で対象リージョンの
   正しいARN・バージョンを確認し、置き換えてください。
2. **`egressNetworkConnectors`のARN** も同様にプレースホルダーです。アカウント/リージョンで
   実際に利用可能なネットワークコネクタARNを確認してください。
3. **MicroVM内部でのIAM認証情報の取得方法**は公式ドキュメントに明記が見当たりませんでした。
   `microvm-worker/app.py`はboto3のデフォルト認証プロバイダーチェーンに任せる実装にしています
   （`executionRoleArn`経由で何らかの形で自動的に認証情報が注入される想定）。実機デプロイ後、
   最初にBedrock/DynamoDB呼び出しが認証エラーにならないか確認してください。
4. **MicroVMの最大稼働時間は8時間**です。超過すると自動サスペンドではなく強制終了されます。
   本プロトタイプには8時間ごとの自動再起動の仕組みは含まれていません（スコープ外）。
   常時稼働のワーカーとして運用する場合は、EventBridge Scheduler等で定期的に
   `RunMicrovm`/`ResumeMicrovm`を呼び直す仕組みを別途追加してください。
5. **アイドル自動サスペンド**はMicroVMのインバウンドHTTPエンドポイントへのトラフィックのみで
   判定され、SQSへの能動的ポーリングはカウントされません。意図しないサスペンドを避けるため、
   `run-microvm`実行時の`idle-policy`は`maxIdleDurationSeconds`を十分に長い値
   （例: 28000秒）に設定してください。

## デプロイ手順

このディレクトリにはNode.js/npmがインストールされていません。以下はローカル環境
（Node.js 20+、AWS CLI設定済み）での実行を想定した手順です。

```fish
cd cdk
npm install
npx cdk bootstrap   # 初回のみ
npx cdk synth        # 生成されるテンプレートを確認してから
npx cdk deploy       # 実際にAWSリソースを作成
```

`cdk deploy`完了後、以下の出力値が表示されます。

- `MicrovmImageName` / `MicrovmImageArn`
- `MicrovmExecutionRoleArn`
- `UploadBucketName`
- `UploadQueueUrl`
- `ResultsTableName`

## MicroVMの起動（手動・CDK外の操作）

実行中のMicroVMインスタンスはCloudFormation/CDKのリソースとして管理できないため、
デプロイ後に1回、CLIで起動します（`<region>`・出力値は実際の値に置き換え）。

```fish
aws lambda-microvms run-microvm \
  --image-identifier <MicrovmImageName の値> \
  --execution-role-arn <MicrovmExecutionRoleArn の値> \
  --maximum-duration-in-seconds 28800 \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":28000,"suspendedDurationSeconds":300}' \
  --ingress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
```

## 動作確認

```fish
set MSG "Rome wasn't built in a day."
echo $MSG > /tmp/message1.txt
aws s3 cp /tmp/message1.txt s3://<UploadBucketName の値>/messages/message1.txt

# 数秒後、DynamoDBに登録されているか確認
aws dynamodb scan --table-name <ResultsTableName の値>
```

## 未実装・今後の検討事項

- 8時間ごとのMicroVM自動再起動（ライフサイクル管理用の軽量Lambda + EventBridge Scheduler）
- CloudWatch Alarmsによる監視・アラート
- SQS DLQ（`UploadDlq`）に溜まったメッセージの再処理フロー
- 冪等性キー（現状はS3オブジェクトのETagベース）の設計見直し（マルチパートアップロード等でのETag仕様の違いに注意）
