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

- `cdk/` — AWS CDK (TypeScript) スタック。`S3MicrovmAsyncStack`（S3・SQS・DynamoDB・IAMロール・MicroVMイメージ定義）と`SyncHelloWorldStack`（同期Hello World用MicroVMイメージ定義）の2スタックを管理。
- `microvm-worker/` — 常駐SQSワーカーのアプリケーションコード（Dockerfile + Python）。SQSをロングポーリングし、Bedrock呼び出し・DynamoDB登録を行う。着信HTTPトラフィックが無いため、idle-suspend機構は実質機能しない（`TODO.md`参照）。
- `microvm-sync-app/` — 同期Hello World PoC（Dockerfile + Flask + uv）。HTTPエンドポイントへの着信リクエストに直接応答するため、idle-suspend機構が実際に機能する対比デモとなる。AWSリソースへは一切アクセスしない。

## 重要な制約（デプロイ前に必ず確認）

AWS Lambda MicroVMsは非常に新しい機能のため、以下はドキュメント調査に基づく設計ですが、
**実機での検証が必須**です。

1. **`baseImageArn` / `baseImageVersion`（`cdk/lib/s3-microvm-async-stack.ts`内`TODO`参照）**
   現時点でプレースホルダー値（`al2023-1` / `1`）を設定しています。デプロイ前に
   `aws lambda-microvms list-microvm-images`（または公式ドキュメント）で対象リージョンの
   正しいARN・バージョンを確認し、置き換えてください。
2. **`egressNetworkConnectors`のARN** も同様にプレースホルダーです。アカウント/リージョンで
   実際に利用可能なネットワークコネクタARNを確認してください。
3. **boto3クライアントはモジュール読み込み時に生成しないこと。** MicroVMsはビルド時
   （`buildRole`）のプロセスメモリスナップショットをそのまま実行時にレジュームするため、
   モジュールレベルで`boto3.client()`等を生成すると、その認証情報解決コンテキストが
   `buildRole`のまま固定され、実行時（`executionRoleArn`）にレジュームしても権限が
   `buildRole`のままになる（実機で`SQS AccessDenied`として顕在化した既知の罠）。
   `microvm-worker/app.py`では`sqs`/`s3`/`bedrock`/`table`をモジュールレベルで`None`初期化し、
   `/run`・`/resume`フック発火後にのみ`init_clients()`で生成する構成にしています。
   他の言語・SDKで実装する場合も同様に、認証情報をキャッシュするSDKオブジェクト全般を
   遅延生成にしてください。
4. **MicroVMの最大稼働時間は8時間**です。超過すると`stateReason: "MicroVM exceeded maximum lifetime."`
   として強制終了されます。**この8時間タイマーはRUNNING/SUSPENDEDいずれの状態でも`startedAt`起点で
   進み続け、SUSPENDED中でも容赦なく強制terminateされることを実機確認済みです**（サスペンドによる
   一時停止という救済措置は無い。検証内容は`research/ai-lambda-microvms-suspend-resume-lifecycle.md`
   「実機検証（2026-07-20）」節参照）。本プロトタイプには8時間ごとの自動再起動の仕組みは
   含まれていません（スコープ外）。常時稼働のワーカーとして運用する場合は、EventBridge Scheduler等で
   定期的に`RunMicrovm`/`ResumeMicrovm`を呼び直す仕組みを別途追加してください。
5. **アイドル自動サスペンド**はMicroVMのインバウンドHTTPエンドポイントへのトラフィックのみで
   判定され、SQSへの能動的ポーリングはカウントされません。意図しないサスペンドを避けるため、
   `run-microvm`実行時の`idle-policy`は`maxIdleDurationSeconds`を十分に長い値
   （例: 28000秒）に設定してください。

## 実機デプロイで判明した罠（教訓）

ドキュメント調査だけでは分からず、実機での試行錯誤で判明した問題です。
本プロジェクトのコードには反映済みですが、他プロジェクトでLambda MicroVMsを使う際にも
共通する罠のため記録しています（詳細な時系列・根本原因分析は`cdk/.claude/HANDOFF.md`参照）。

1. **フック用ポートはアプリ本体のポートと必ず分離すること。**
   `/ready`フックタイムアウト（`Ready hook invocation timed out after PT5M`）の根本原因は、
   フック用HTTPリスナーをアプリ本体と同じポート（8080）で共用していたこと。公式ドキュメント・
   Agent Skillのサンプル実装は例外なくアプリ用ポートとフック専用ポート（例: 9000）を
   別リスナー・別スレッドで起動している。本プロジェクトでは`microvm-worker/app.py`の
   フックサーバーを`HOOKS_PORT`（デフォルト9000）で待ち受けるように分離し、
   `microvm-worker/Dockerfile`（`EXPOSE 9000`）・
   `cdk/lib/s3-microvm-async-stack.ts`（`hooks.port: 9000`）も合わせて修正済み。
   VPC/NetworkConnector構成、アプリコードの複雑さ、`readyTimeoutInSeconds`の長さは
   原因ではなかった（切り分け済み）。
2. **boto3クライアントは`/run`・`/resume`フック発火後に遅延生成すること。**
   上記「重要な制約」3番目参照。モジュール読み込み時に生成すると、ビルド時ロール
   （`buildRole`）の認証情報解決コンテキストがスナップショットに固定され、実行時に
   `executionRoleArn`へレジュームしても権限がbuildRoleのままになる。
3. **オンデマンドスループット非対応のBedrockモデルは推論プロファイル経由で呼び出すこと。**
   `anthropic.claude-haiku-4-5-20251001-v1:0`を基盤モデルARNとして直接呼び出すと
   `ValidationException`になる。`aws bedrock list-inference-profiles`で確認した
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`（クロスリージョン推論プロファイル）を
   `modelId`に指定する必要がある。IAMポリシーの`resources`も推論プロファイルARNと
   基盤モデルARN（リージョンワイルドカード）の両方を許可すること。
4. **Dockerfile内で`ghcr.io`等、PyPI/Amazon Linuxリポジトリ/`public.ecr.aws`以外の外部レジストリに
   到達しようとするとイメージビルドがハングする。**
   `microvm-sync-app/Dockerfile`で`COPY --from=ghcr.io/astral-sh/uv:latest ...`によりuvバイナリを
   取得する構成にしたところ、`CfnMicrovmImage`のビルドが30分以上`CREATE_IN_PROGRESS`のまま
   進行せず、CloudFormationが`Exceeded attempts to wait`（`NotStabilized`）でタイムアウトした。
   `aws lambda-microvms list-microvm-image-builds`で確認しても`buildState: IN_PROGRESS`のまま
   変化がなく、対応するCloudWatch Logsロググループ（`/aws/lambda-microvms/<image-name>`）すら
   作成されていなかった（正常にビルドできた`s3-microvm-async-worker`では即座に作成されていた）。
   `pip install`（PyPI）は既存ワーカーで疎通実績があるため、`uv`本体もPyPI経由
   （`python3.13 -m pip install uv`）で取得するよう変更したところ、**約2.5分でCREATE_COMPLETE**し、
   ロググループも即座に作成された。修正前後でこの一点しか差分が無いため、
   **「AWS Lambda MicroVMsのイメージビルド環境は`ghcr.io`（あるいはPyPI/Amazon Linux
   リポジトリ/`public.ecr.aws`以外の外部レジストリ全般）に到達できない」という原因は
   実機で確認済み**とみなしてよい水準の再現性が得られた。
   なお、一度ハングしたビルド（`CfnMicrovmImage`のバージョン）は`IN_PROGRESS`のまま
   キャンセル手段がなく（`delete-microvm-image-version`/`delete-microvm-image`はいずれも
   `IN_PROGRESS`中は失敗する）、CloudFormationスタックも`ROLLBACK_FAILED`/`DELETE_FAILED`に
   陥る。ビルドが自然に終了するまで待つ以外の回避策は見つかっていない。
5. **`run-microvm`の`--image-identifier`はイメージ名だけでは受け付けられず、フルARNが必要。**
   `--image-identifier sync-hello-world-app`のようにイメージ名のみを渡すと
   `ValidationException: Malformed ARN - doesn't start with 'arn:'`で失敗する。
   `cdk deploy`の出力である`SyncAppImageArn`（または`MicrovmImageArn`）をそのまま渡すこと。
6. **HTTPエンドポイントへのアクセスは、`Authorization`ヘッダーでもURLへの`:8080`付与でもなく、
   専用ヘッダー`X-aws-proxy-auth`（認証トークン）と`X-aws-proxy-port`（転送先ポート）で行う。**
   `get-microvm`が返す`endpoint`はホスト名のみでポートを含まず、常にHTTPS(TLS)でアクセスする。
   `Authorization: Bearer <token>`や`https://<endpoint>:8080/`という形式では403や無応答タイムアウト
   になる（詳細は`research/ai-lambda-microvms-http-endpoint-auth.md`参照）。加えて、
   `create-microvm-auth-token`のレスポンスはトップレベルの`token`ではなく
   `authToken."X-aws-proxy-auth"`にJWE文字列が入っている点にも注意（後述の動作確認手順に反映済み）。

## デプロイ手順

このディレクトリにはNode.js/npmがインストールされていません。以下はローカル環境
（Node.js 20+、AWS CLI設定済み）での実行を想定した手順です。

```fish
cd cdk
npm install
npx cdk bootstrap   # 初回のみ
npx cdk synth        # 生成されるテンプレートを確認してから
npx cdk deploy --all # 実際にAWSリソースを作成（両スタック）
```

特定のスタックだけデプロイしたい場合はスタック名を指定します（`npx cdk list`で一覧表示可能）。

```fish
npx cdk deploy S3MicrovmAsyncStack
npx cdk deploy SyncHelloWorldStack
```

`S3MicrovmAsyncStack`のデプロイ完了後、以下の出力値が表示されます。

- `MicrovmImageName` / `MicrovmImageArn`
- `MicrovmExecutionRoleArn`
- `UploadBucketName`
- `UploadQueueUrl`
- `ResultsTableName`

`SyncHelloWorldStack`のデプロイ完了後は以下が表示されます。

- `SyncAppImageName` / `SyncAppImageArn`
- `SyncExecutionRoleArn`

## MicroVMの起動（手動・CDK外の操作）

実行中のMicroVMインスタンスはCloudFormation/CDKのリソースとして管理できないため、
デプロイ後に1回、CLIで起動します（`<region>`・出力値は実際の値に置き換え）。

### 常駐SQSワーカー（`S3MicrovmAsyncStack`）

```fish
aws lambda-microvms run-microvm \
  --image-identifier <MicrovmImageArn の値> \
  --execution-role-arn <MicrovmExecutionRoleArn の値> \
  --maximum-duration-in-seconds 28800 \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":28000,"suspendedDurationSeconds":300}' \
  --ingress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
```

### 同期Hello Worldアプリ（`SyncHelloWorldStack`）

このアプリはHTTPエンドポイントへの着信で直接動作するため、idle-suspendの動作確認を
短時間で行えるよう`maxIdleDurationSeconds`を短め（60秒）に設定しています。

```fish
aws lambda-microvms run-microvm \
  --image-identifier <SyncAppImageArn の値> \
  --execution-role-arn <SyncExecutionRoleArn の値> \
  --maximum-duration-in-seconds 28800 \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":60,"suspendedDurationSeconds":300}' \
  --ingress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
```

**注意**: `--ingress-network-connectors`に`ALL_INGRESS`を指定するため、発行されるエンドポイントURLは
（トークン等の認証を除けば）到達可能になります。このPoCはAWS権限を一切持たずHello Worldしか返しませんが、
エンドポイントURLをコミット・共有ドキュメント等に残さないでください。検証後は下記の`terminate-microvm`で
必ず終了させてください。

## 動作確認

### 常駐SQSワーカー

```fish
set MSG "Rome wasn't built in a day."
echo $MSG > /tmp/message1.txt
aws s3 cp /tmp/message1.txt s3://<UploadBucketName の値>/messages/message1.txt

# 数秒後、DynamoDBに登録されているか確認
aws dynamodb scan --table-name <ResultsTableName の値>
```

### 同期Hello Worldアプリ

`run-microvm`のレスポンス（または`get-microvm`）の`endpoint`フィールド（ホスト名のみ、スキーム・ポート
は含まない）を取得し、認証トークンを発行したうえで、専用ヘッダー`X-aws-proxy-auth`（トークン）・
`X-aws-proxy-port`（転送先ポート）を付けてリクエストします。`Authorization`ヘッダーや`https://<endpoint>:8080/`
のようなURLへの直接のポート付与では403や無応答タイムアウトになるため注意してください
（詳細は`research/ai-lambda-microvms-http-endpoint-auth.md`参照）。

```fish
set MICROVM_ID <run-microvmレスポンスのmicrovmIdの値>
set ENDPOINT (aws lambda-microvms get-microvm --microvm-identifier $MICROVM_ID --query endpoint --output text)
set TOKEN (aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier $MICROVM_ID \
  --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
curl "https://$ENDPOINT/" \
  -H "X-aws-proxy-auth: $TOKEN" \
  -H "X-aws-proxy-port: 8080"
# => {"message":"Hello, World!"}
```

idle-suspendの動作確認: 60秒（`maxIdleDurationSeconds`）以上リクエストを送らずに待った後、
`get-microvm`で`state`が`SUSPENDED`になっていることを確認し、再度上記と同じ`curl`（トークンの
有効期限が切れていなければ再発行不要）を送ると`autoResumeEnabled=true`により自動的に`RUNNING`へ
復帰してHello Worldが返ります（実機確認では約1秒で復帰、`research/ai-lambda-microvms-suspend-resume-lifecycle.md`参照）。

```fish
aws lambda-microvms get-microvm --microvm-identifier $MICROVM_ID --query state --output text
```

検証後は必ず終了させてください。

```fish
aws lambda-microvms terminate-microvm --microvm-identifier $MICROVM_ID
```

## 未実装・今後の検討事項

- 8時間ごとのMicroVM自動再起動（ライフサイクル管理用の軽量Lambda + EventBridge Scheduler）
- CloudWatch Alarmsによる監視・アラート
- SQS DLQ（`UploadDlq`）に溜まったメッセージの再処理フロー
- 冪等性キー（現状はS3オブジェクトのETagベース）の設計見直し（マルチパートアップロード等でのETag仕様の違いに注意）
- 同期Hello Worldアプリ（`SyncHelloWorldStack`）はPoCのため`ALL_INGRESS`のまま。認証・アクセス制御は未実装。
