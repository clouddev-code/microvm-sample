# Lambda MicroVMsのイメージビルドとBedrock Claude Haiku 4.5呼び出し方法

## MicroVMイメージのビルド・パッケージング方式
MicroVMイメージはDockerfileベースのコンテナイメージとして作成する。rootfsアーカイブなど独自形式は不要で、`Dockerfile`とアプリケーションコードをzip化し、Amazon S3にアップロードした上でLambdaが参照する。ビルド時、LambdaはS3から成果物を取得し、Lambda管理のMicroVMベースイメージ上で新規MicroVMを起動して`Dockerfile`の命令を実行し、`ENTRYPOINT`/`CMD`でアプリケーションを起動、初期化完了をライフサイクルフックで検知した後にディスクとメモリのスナップショットを取得する。

サンプル構成は次のとおり。

```
app.js       # Node.jsのHTTPサーバー（ポート8080でリッスン）
Dockerfile   # アプリ層の定義
```

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY app.js .
EXPOSE 8080
CMD ["node", "app.js"]
```

`FROM`にはLambda提供のベースイメージ（`public.ecr.aws/lambda/microvms:al2023-minimal`）か、要件を満たす任意のコンテナベースイメージを指定できる。コンテナベースイメージの制約は、対象CPUアーキテクチャとの互換性、Linux OSベースであること、Lambdaビルドインフラからアクセス可能であること（パブリックまたは同一アカウントのECR）、スナップショット互換であることの4点である。一方、MicroVMのOS環境そのものを提供する「MicroVMベースイメージ」はLambda管理のAmazon Linux 2023イメージ（例: `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`）に固定されており、任意のディストリビューションには変更できない。

### ライフサイクルフックの実装規約
フックはすべてアプリケーションが公開するHTTPエンドポイントとして実装し、言語やスクリプト形式は問わない。イメージビルド時のフックと実行時のフックの2系統がある。

- `/ready`（`/aws/lambda-microvms/runtime/v1/ready`）: `ENTRYPOINT`/`CMD`起動後に呼ばれ、初期化完了をHTTP 200で通知するとLambdaがスナップショットを取得する。未完了時はHTTP 503を即座に返し、リトライされる。
- `/validate`（`/aws/lambda-microvms/runtime/v1/validate`）: ビルド完了後、新規MicroVM上で呼ばれ、スナップショットからの復元後にアプリが正常動作するか検証する。
- `/run`: `run-microvm`実行時に呼ばれる起動フック。`--run-hook-payload`で渡した文字列（最大16KB）とLambdaが注入する`microvmId`を含むJSONがリクエストボディとして渡される。ペイロード例は`{"microvmId": "mvm-...", "runHookPayload": "tenant-specific-string"}`。
- `/suspend`・`/resume`: それぞれMicroVM停止前・再開後に呼ばれ、接続のクローズや再確立、資格情報の更新などに使う。

フックを1つでも設定する場合は、アプリがリッスンするポート番号を明示的に指定する必要がある。

### ビルド・登録・実行のCLIコマンド例

```bash
zip app.zip app.js Dockerfile
aws s3 cp app.zip s3://your-bucket-name/app.zip

aws lambda-microvms create-microvm-image \
  --name my-first-microvm-image \
  --code-artifact uri=s3://your-bucket-name/app.zip \
  --base-image-arn arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::123456789012:role/MicrovmBuildRole

aws lambda-microvms get-microvm-image --image-identifier my-first-microvm-image

aws lambda-microvms run-microvm \
  --image-identifier my-first-microvm-image \
  --ingress-network-connectors "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":900,"suspendedDurationSeconds":300}'
```

ビルドロールには`s3:GetObject`と`logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents`が最低限必要で、プライベートECRから取得する場合は`ecr:GetAuthorizationToken`と`ecr:BatchGetImage`も追加する。

## Amazon Bedrock Claude Haiku 4.5の呼び出し方法

### モデルIDとリージョン
`bedrock-runtime`エンドポイントで使用するモデルIDは`anthropic.claude-haiku-4-5-20251001-v1:0`である。クロスリージョン推論プロファイルとして`us.`・`eu.`・`au.`・`jp.`・`global.`の各プレフィックス付きIDも提供されている。日本語解説を生成する用途では東京リージョン（ap-northeast-1）がIn-Region・Geo・Globalのいずれの推論方式にも対応しているため、東京リージョンでのIn-Region呼び出しが選択できる。一方、大阪（ap-northeast-3）やソウル（ap-northeast-2）はIn-Region非対応であり、Geo/Globalクロスリージョン推論のみ利用可能な点に注意する。

### Converse APIの呼び出し例（Python/boto3）

```python
import boto3

client = boto3.client("bedrock-runtime", region_name="ap-northeast-1")
response = client.converse(
    modelId="anthropic.claude-haiku-4-5-20251001-v1:0",
    messages=[
        {"role": "user", "content": [{"text": "この画像について日本語で解説してください。"}]}
    ],
)
print(response["output"]["message"]["content"][0]["text"])
```

ストリーミングが必要な場合は`converse_stream`（`ConverseStream`）を使用する。

### 必要なIAMアクション
`Converse`呼び出しには`bedrock:InvokeModel`アクションの権限で足り、`ConverseStream`呼び出しには`bedrock:InvokeModelWithResponseStream`の権限が必要である。Converse系APIは内部的にInvokeModel系のアクションで権限判定されるため、個別の`bedrock:Converse`アクションは存在しない。今回のプロトタイプ（同期呼び出しのみ）であれば`bedrock:InvokeModel`のみで十分である。

## 参考リンク
- [Create your first Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html)
- [MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Claude Haiku 4.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)
- [Inference using Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
