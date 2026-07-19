# AWS Lambda MicroVMs の /ready・/validate フックタイムアウト調査

`https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html`（MicroVM images / build hooks）を起点に、Getting Startedガイドおよび検証済みAgent Skill（`aws-lambda-microvms`）の参照資料を確認した。あわせて自プロジェクトの`Dockerfile`・`app.py`・CDKスタック（`CfnMicrovmImage`）の実装を突き合わせ、`Ready hook invocation timed out after PT5M`の原因になりうる差分候補を洗い出した。

## 1. サンプルDockerfileとベースイメージ、CMD/ENTRYPOINTの指定方法
公式ドキュメントには2種類のサンプルがある。いずれも`CMD`は配列形式（exec form）で記述されており、シェル形式（`CMD node app.js`のような文字列形式）は使われていない。

`microvms-getting-started.html`（Getting Started）に掲載されているNode.jsの最小サンプルは以下のとおり。

```
// app.js
// Minimal HTTP server — listens on port 8080
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: req.url }));
});

server.listen(8080, () => {
  console.log('Listening on port 8080');
});
```

```
# Dockerfile
# Use a lightweight Node.js runtime for your application layers
FROM node:24-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy your application code
COPY app.js .

# Declare the port your app listens on
EXPOSE 8080

# Start the application — Lambda snapshots the running state
CMD ["node", "app.js"]
```

このサンプルには**`--hooks`パラメータが一切渡されていない**。`create-microvm-image`の呼び出しは次の1コマンドのみである。

```
aws lambda-microvms create-microvm-image \
  --name my-first-microvm-image \
  --code-artifact uri=s3://{{your-bucket-name}}/app.zip \
  --base-image-arn arn:aws:lambda:{{us-east-1}}:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::{{123456789012}}:role/MicrovmBuildRole
```

つまり「ドキュメント通りに作ったら問題なく作れた」というユーザー報告は、**フックを一切設定しない構成**での成功であり、フック関連の問題を経験しない構成だったことになる。

`FROM`命令についてはドキュメントで次のように明記されている。

> The `FROM` instruction sets the container image for your application layers. You can use any compatible container image. The Lambda managed base image (which provides the MicroVM operating system and service components) is specified separately with `--base-image-arn` in Step 3.

もう一つ、検証済みAgent Skill（`aws-lambda-microvms`）の`getting-started.md`には、フックを併用するPython(Flask)サンプルが掲載されている（次項で全文を引用）。こちらは`FROM public.ecr.aws/lambda/microvms:al2023-minimal`（Lambda提供の推奨コンテナベースイメージ）を使っており、`EXPOSE`にアプリのポートとフックのポートを両方列挙している。

```dockerfile
# Dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y python3 python3-pip && dnf clean all
RUN pip install --no-cache-dir flask==3.0.3
COPY app.py .
EXPOSE 8080 9000
CMD ["python", "app.py"]
```

## 2. /ready・/validateフックの実装方法
### 2.1 フックの契約（パス・メソッド・レスポンス・タイムアウト）
`microvms-images.html`の該当表を原文のまま引用する。

> | Hook | Path | Details | HTTP Status Codes | Timeout |
> | --- | --- | --- | --- | --- |
> | /ready | /aws/lambda-microvms/runtime/v1/ready | Called during the MicroVM image build, after your application starts via ENTRYPOINT or CMD. Signals that your application is ready to be snapshotted. | HTTP 503: Not yet ready; Lambda retries until timeout. HTTP 200: Initialization complete; Lambda takes the snapshot. | 1–3600 seconds (readyTimeoutInSeconds) |
> | /validate | /aws/lambda-microvms/runtime/v1/validate | Called after the build completes, on a new MicroVM started from the created image. Confirms the application works correctly when resumed. | HTTP 503: Validation needs more time to complete; Lambda retries until timeout. HTTP 200: Validation passed. | 1–3600 seconds (validateTimeoutInSeconds) |

タイムアウト時の挙動について、503応答の扱いが明記されている。

> **Important**
> When returning HTTP 503, return it immediately rather than holding the request open while you wait. If the timeout elapses while a request is held open, Lambda ends the build.

Agent Skillの`references/lifecycle-model.md`は、実際のHTTPメソッドが**POST**であることを明示している（本文の表には記載がないため見落としやすい点）。

> | **`/ready`** | `POST /aws/lambda-microvms/runtime/v1/ready` | During image build, before snapshot capture | `readyTimeoutInSeconds` (1–3600) | Confirm app initialized; fail the build if app is broken |
> | **`/validate`** | `POST /aws/lambda-microvms/runtime/v1/validate` | After build, on a test MicroVM run from the snapshot | `validateTimeoutInSeconds` (1–3600) | End-to-end smoke test of the snapshot |

また同資料は、フックの有効化フラグ（`ENABLED`/`DISABLED`）が呼び出しパス自体ではなく「その呼び出しを行うかどうかのスイッチ」であることを明記している。

> A hook left at its default `DISABLED` is not called even if the application implements the path.

ポートとバインドアドレスについては次の記述がある（`microvms-images.html`本文と、Skillの`troubleshooting.md`/`lifecycle-model.md`双方で一致）。

> **Important**
> If you configure any hooks, you must specify the port that your application listens on for hook requests.

> Hook server **must bind to `0.0.0.0`** on the configured `port` (commonly 9000). `127.0.0.1`-only listeners are unreachable from Lambda's hook caller.

### 2.2 サンプル実装コード（Flask、フックport分離）
Agent Skill `references/getting-started.md`に掲載されている実装（アプリ用ポート8080とフック用ポート9000を**同一プロセス内で分離**して立てる構成）を全文引用する。

```python
# app.py
from flask import Flask
import threading

# Application port (default routed by proxy from external 80/443)
app = Flask(__name__)
@app.get("/")
def root(): return {"hello": "world"}

# Lifecycle hooks port
hooks = Flask("hooks")
P = "/aws/lambda-microvms/runtime/v1"
@hooks.post(f"{P}/ready")
def ready(): return "", 200
@hooks.post(f"{P}/run")
def run(): return "", 200
@hooks.post(f"{P}/resume")
def resume(): return "", 200
@hooks.post(f"{P}/suspend")
def suspend(): return "", 200
@hooks.post(f"{P}/terminate")
def terminate(): return "", 200

if __name__ == "__main__":
    threading.Thread(target=lambda: hooks.run(host="0.0.0.0", port=9000), daemon=True).start()
    app.run(host="0.0.0.0", port=8080)
```

このサンプルでは`/validate`ハンドラが定義されていない（`create-microvm-image`呼び出し側でも`validate`は`ENABLED`にしていない）。つまりフックは**必要なものだけ`ENABLED`にし、対応するパスのみ実装すればよい**という設計である。

## 3. CreateMicrovmImage呼び出し時のhooksパラメータ指定例
`hooks`は`port` / `microvmHooks` / `microvmImageHooks`の3つのトップレベルキーを持つ構造体で、boto3の`create_microvm_image`リクエスト構文は次のとおり。

```
hooks={
    'port': 123,
    'microvmHooks': {
        'run': 'DISABLED'|'ENABLED',
        'runTimeoutInSeconds': 123,
        'resume': 'DISABLED'|'ENABLED',
        'resumeTimeoutInSeconds': 123,
        'suspend': 'DISABLED'|'ENABLED',
        'suspendTimeoutInSeconds': 123,
        'terminate': 'DISABLED'|'ENABLED',
        'terminateTimeoutInSeconds': 123
    },
    'microvmImageHooks': {
        'ready': 'DISABLED'|'ENABLED',
        'readyTimeoutInSeconds': 123,
        'validate': 'DISABLED'|'ENABLED',
        'validateTimeoutInSeconds': 123
    }
}
```

Agent Skillに掲載されているCLI実行例（`--hooks`をJSON文字列で渡す形）は次のとおり。

```bash
aws lambda-microvms create-microvm-image \
  --name my-first-image \
  --description "Hello world Flask app" \
  --base-image-arn arn:aws:lambda:<region>:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::123456789012:role/MicroVMBuildRole \
  --code-artifact '{"uri":"s3://my-bucket/microvm-images/my-first-image/code-artifact.zip"}' \
  --hooks '{
    "port": 9000,
    "microvmImageHooks": {
      "ready": "ENABLED",
      "readyTimeoutInSeconds": 60
    },
    "microvmHooks": {
      "run": "ENABLED",
      "runTimeoutInSeconds": 2,
      "resume": "ENABLED",
      "resumeTimeoutInSeconds": 2,
      "suspend": "ENABLED",
      "suspendTimeoutInSeconds": 5,
      "terminate": "ENABLED",
      "terminateTimeoutInSeconds": 5
    }
  }'
```

`port`が9000固定になっている点に注目したい。このサンプルの`app.py`は、アプリ本体のポート（8080）とは**別のポート（9000）**でフック用Flaskアプリを起動しており、`--hooks`の`port`もその9000に合わせている。

CDK(TypeScript)で`CfnMicrovmImage`を使う場合、`hooks`プロパティの型は`HooksProperty`（`microvmHooks?`, `microvmImageHooks?`, `port?`）で、CloudFormationの`AWS::Lambda::MicrovmImage Hooks`と1対1で対応する。

> `Port` The port number on which the hooks listener runs.
> *Required*: No *Type*: Integer *Minimum*: `1` *Maximum*: `65535`

`MicrovmImageHooks.Ready`/`.Validate`は、CloudFormationスキーマ上も文字列ではなく`ENABLED`/`DISABLED`の列挙値である。

> `Ready` The path of the hook invoked when the MicroVM image build is ready.
> *Required*: No *Type*: String *Allowed values*: `DISABLED | ENABLED`

（説明文に「path」という語が残っているが、`Allowed values`が`DISABLED | ENABLED`である以上、実際にはトグルスイッチであり、呼び出し先パスは`/aws/lambda-microvms/runtime/v1/ready`に固定である。ドキュメントの説明文とスキーマ定義に不整合がある点は要注意。）

## 4. egressNetworkConnectors・baseImageArn/baseImageVersionの指定例
Getting Startedの`run-microvm`コマンド例では、Lambda管理の固定ARNコネクタが使われている。

```
aws lambda-microvms run-microvm \
  --image-identifier my-first-microvm-image \
  --ingress-network-connectors "arn:aws:lambda:{{us-east-1}}:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:{{us-east-1}}:aws:network-connector:aws-network-connector:INTERNET_EGRESS" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":900,"suspendedDurationSeconds":300}'
```

なお`egressNetworkConnectors`は`CreateMicrovmImage`（イメージ側）にも存在するパラメータで、ドキュメント上は次のように説明されている。

> **egressNetworkConnectors**: The list of egress network connectors available to the MicroVM at runtime.

`baseImageArn`はマネージドベースイメージのARNで、次の形式・取得コマンドが示されている。

```
# List all managed MicroVM base images
aws lambda-microvms list-managed-microvm-images

# List the versions of a specific managed MicroVM base image
aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier arn:aws:lambda:{{us-east-1}}:aws:microvm-image:al2023-1
```

`baseImageVersion`（省略可）については次の記述がある。

> By default, the latest version of a service-managed base image applies when you are creating/updating your own MicroVM images. For troubleshooting or debugging, you can optionally override the version of the service-managed based images when creating your own MicroVM image using the `base-image-version` parameter.

ライフサイクル（`AVAILABLE`→`DEPRECATED`60日→`EXPIRING`30日→`EXPIRED`→`RECALLED`）も明記されているが、具体的なバージョン文字列の命名規則（数値なのか日付なのか）は本ページに記載がなく、`list-managed-microvm-image-versions`で実際に確認する以外に確定させる手段がない。CloudFormationスキーマ上、`BaseImageVersion`は`Pattern: ^[^\s]+$`（空白を含まない任意の非空文字列）としか規定されておらず、`"0"`のような単純な数値文字列がリージョン・時期を問わず常に有効である保証はドキュメント上ない。

## 5. ビルドロール（buildRoleArn）に付与している権限例
Getting Startedの前提条件セクションに、信頼ポリシーと権限ポリシーの全文がある。

信頼ポリシー（Lambdaサービスがロールを引き受けるためのもの）。

```
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}
```

権限ポリシー（S3読み取りとCloudWatch Logsへの書き込み）。

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<your-bucket-name>/*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
```

> **Note**
> If your `Dockerfile` pulls from a private AWS ECR repository, also add `ecr:GetAuthorizationToken` and `ecr:BatchGetImage` to the permissions policy.

私設ECRリポジトリを`FROM`で参照する場合に追加すべき権限（別ページ「Container base images」より）。

```
{
  "Effect": "Allow",
  "Action": [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage"
  ],
  "Resource": "*"
}
```

なお、ビルドロールと実行ロールに割り当てられる責務は明確に分離されており（別途調査済みの`microvms-security.html`より）、ビルドロールは`/ready`・`/validate`のみを担当し、`/run`・`/resume`・`/suspend`・`/terminate`は実行ロール（`executionRoleArn`）配下で動作する。

## 6. 既知の制約・注意点
本ドキュメントページおよびAgent Skillが挙げる制約・注意点のうち、HTTPサーバー実装とヘルスチェック応答に直結するものを整理する。

- 503応答は「保留せず即座に返す」こと。処理待ちの間リクエストを保持したままにすると、設定したタイムアウトの前にLambda側がビルドを打ち切る（原文: "When returning HTTP 503, return it immediately rather than holding the request open while you wait. If the timeout elapses while a request is held open, Lambda ends the build."）。
- フックサーバーは`0.0.0.0`にバインドする必要がある。`127.0.0.1`のみのリスナーはLambdaのフック呼び出し元から到達不能になる（原文: "Hook server must bind to `0.0.0.0` on the configured port... `127.0.0.1`-only listeners are unreachable from Lambda's hook caller."）。
- フックを1つでも設定する場合、`port`の指定が必須。設定を忘れると`--hooks`全体が意図通り機能しない。
- `Dockerfile`で`EXPOSE`を忘れることは既知の落とし穴として明記されている（Skill `getting-started.md`より）。「Forgetting to `EXPOSE <your application port>` in the Dockerfile — all apps run in a container, so the port your hooks and server bind to must be exposed.」
- フックは非同期契約であり、アプリがブロックして応答を返さない場合、設定タイムアウトより先にプラットフォーム側がタイムアウトする可能性がある（Skill `troubleshooting.md`より）。「The `/ready` and `/validate` hooks are asynchronous — return 503 until the application is ready/validated, and the platform will retry. If the application blocks instead of returning 503, the platform may time out before the configured timeout.」
- `/run`・`/resume`・`/suspend`・`/terminate`（MicroVM実行時フック）は1〜60秒という短いタイムアウト範囲しか許容されず、長時間処理には使えない。
- MicroVM実行時フックを1つでも使う場合は`/ready`イメージビルドフックの実装が前提とされる（Skill `lifecycle-model.md`より）。「If you use microVM hooks, you must implement the `/ready` microVM image hook. This ensures your application has booted and can receive hook events.」

## 7. 自プロジェクト実装との差分候補（原因切り分け）
以下は、公式ドキュメント・Agent Skillのサンプルと、本プロジェクトの`Dockerfile`（`microvm-worker/Dockerfile`）・`app.py`・CDKスタック（`lib/s3-microvm-async-stack.ts`の`CfnMicrovmImage`）を突き合わせて洗い出した差分候補である。優先度が高いと考えられる順に列挙する。

- **フック用ポートをアプリのサービスポートと共用している点。** 公式Getting Startedの最小サンプルはそもそもフック非使用、Agent Skillのフック付きサンプルは一貫して「アプリ用8080」「フック用9000」を**別ポート・別リスナー**として起動している（`threading.Thread`でフック用Flaskを別スレッド起動）。本プロジェクトは`hooks.port: 8080`とし、SQSワーカー本体と同じ`http.server`インスタンス（単一ポート・単一プロセス）にフックを相乗りさせている。ドキュメント本文は「同一ポートの共用を禁止」とは明記していないが、フック呼び出し経路とアプリ用トラフィック経路（ingress proxyの既定ターゲットポートも8080）が同一ポートに重なる構成は、公式サンプルでは一度も検証されていない組み合わせであり、ビルド時のフック呼び出し経路（builderサンドボックスからのPOST）がアプリ用の実行時プロキシ経路と混同・干渉していないか、ポートを分離して切り分ける価値がある。
- **`baseImageVersion: '0'`という値がドキュメント上裏付けのない決め打ち値である点。** 既存調査（`ai-lambda-microvm-base-image-arn.md`）でも指摘済みだが、`"1"`は`InvalidRequest`になった一方で`"0"`はビルドが`CREATING`まで進行している。公式ドキュメントは`BaseImageVersion`省略時に自動的に最新版が使われると明記しており（"By default, the latest version of a service-managed base image applies"）、フック呼び出しを仲介するエージェントは「サービスコンポーネント」としてベースイメージ側に同梱されている（"a Lambda-managed MicroVM base image...which provides the Amazon Linux 2023 operating system and the service components required to run MicroVMs"）。`baseImageVersion`を省略（最新版を使用）した場合と挙動が変わるかどうかは、切り分けの一環として試す価値がある。
- **`readyTimeoutInSeconds`/`validateTimeoutInSeconds`を300秒に延長して切り分けを試みている点。** これはタイムアウト値そのものの問題ではなく「フック呼び出しが物理的にコンテナへ届いていない」ことを示唆する。ドキュメントが定義する契約（503を即座に返す・0.0.0.0でバインドする）は両方満たされているため、タイムアウト延長では解決しない可能性が高く、根本原因はネットワーク到達性（フックのport設定・EXPOSE設定・ベースイメージのフック転送コンポーネント）にある可能性が高い。
- **`CMD`形式・`FROM`の選定は公式サンプルと一致している。** `CMD ["python3.13", "app.py"]`という配列形式（exec form）であり、`FROM public.ecr.aws/lambda/microvms:al2023-minimal`もAgent Skill推奨のベースイメージと一致する。`EXPOSE 8080`もアプリ・フック共用ポートと一致しており、この観点では差分は見当たらない。
- **フックのHTTPパス・メソッドの実装自体には問題がない。** `app.py`の`BaseHTTPRequestHandler`は`do_GET`/`do_POST`双方で無条件に200を返す実装であり、`/aws/lambda-microvms/runtime/v1/ready`のような固定パスへのPOSTであっても取りこぼさない。したがって「フックのパスが`/ready`という文字列そのものだと誤解している」といったアプリケーションロジック側の実装ミスは、少なくとも今回の最小再現構成には該当しない。
- **`logging: { disabled: false }`はCDK/CloudFormationのスキーマ上は正しい。** boto3の生API仕様では`logging.disabled`はタグ付きユニオンの空オブジェクト`{}`だが、CloudFormationリソースリファレンス（`AWS::Lambda::MicrovmImage Logging`）では`Disabled`は`Type: Boolean`と明記されており、CDKの`{ disabled: false }`はCFN側の正しい表現である。実際にCloudWatch Logsにアプリのログが出力されている（"Listening on 0.0.0.0:8080"のログが確認できている）ことからも、ロギング自体は機能しており、ここは原因ではないと判断してよい。
- **`egressNetworkConnectors: ['...INTERNET_EGRESS']`はドキュメントの用法と一致している。** Lambda管理の固定ARNコネクタであり、カスタムVPCコネクタのようなENIプロビジョニング待ち（`PENDING`が10分以上続く既知の障害パターン）は原理上発生しない構成のため、ここも主要因の可能性は低いと考えられる。ただし、ビルド時のフック呼び出しがingress/egressコネクタと同じ経路を使うのか、あるいはビルドサンドボックス専用の内部経路を使うのかは、いずれのドキュメントにも明記がなく確認できなかった。

以上より、最も優先して検証すべき差分は「フック用ポートをアプリ本体と共用せず、公式サンプル通り別ポート（例: 9000）に分離し、`hooks.port`もそれに合わせる」構成への変更、および「`baseImageVersion`を省略して最新版のマネージドベースイメージで再ビルドする」ことの2点である。いずれもドキュメントの記述からは確定的な原因特定はできないため、上記2点を切り分けた上でなお解消しない場合は、AWSサポートへの問い合わせ、または`SHELL_INGRESS`ネットワークコネクタを使ったビルド中コンテナへの直接シェルアクセス（Agent Skillの"When all else fails"手順）による実地調査を推奨する。

## 参考リンク
- [MicroVM images (MicroVM image build hooks)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Create your first Lambda MicroVM (Getting Started)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html)
- [AWS::Lambda::MicrovmImage](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-microvmimage.html)
- [AWS::Lambda::MicrovmImage Hooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-hooks.html)
- [AWS::Lambda::MicrovmImage MicrovmImageHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmimagehooks.html)
- [AWS::Lambda::MicrovmImage Logging](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-logging.html)
- [create_microvm_image (boto3 reference)](https://docs.aws.amazon.com/boto3/latest/reference/services/lambda-microvms/client/create_microvm_image.html)
- [interface HooksProperty (CDK aws-cdk-lib.aws_lambda.CfnMicrovmImage)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.CfnMicrovmImage.HooksProperty.html)
- [aws-lambda-microvms Agent Skill: getting-started.md / lifecycle-model.md / networking.md / troubleshooting.md（AWS MCPサーバー経由で取得した検証済み実装手順）]
