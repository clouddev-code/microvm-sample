# AWS Lambda MicroVMs API 調査メモ（プレビュー）

> APIバージョン: `2025-09-09` / ドキュメント最終更新: 2026-07-03

---

## SuspendMicrovm API

### エンドポイントとパラメータ

```
POST /2025-09-09/microvms/{microvmIdentifier}/suspend HTTP/1.1
```

| 項目 | 内容 |
|------|------|
| HTTPメソッド | `POST` |
| URIパラメータ | `microvmIdentifier`（MicroVMのID、1〜256文字）**必須** |
| リクエストボディ | なし |
| 成功レスポンス | `HTTP 200`（空のボディ） |

主なエラーコードは以下のとおり。

- `403 AccessDeniedException` - 権限不足
- `404 ResourceNotFoundException` - 指定IDが存在しない
- `409 ConflictException` - MicroVMが RUNNING 以外の状態（例: すでに SUSPENDING）
- `429 ThrottlingException` - レートリミット超過

### boto3 での呼び出し方法

boto3 のサービス名は **`lambda-microvms`** 。

```python
import boto3

client = boto3.client("lambda-microvms")

response = client.suspend_microvm(
    microvmIdentifier="mvm-01234567-abcd-ef01-2345-6789abcdef01"
)
# 成功時: response == {}
```

クライアントクラス名は `LambdaMicroVMs`、メソッド名は `suspend_microvm`。

---

## MicroVM内からの自身のID取得

### 結論: IMDS相当のエンドポイントは存在しない

EC2の Instance Metadata Service (169.254.169.254) に相当する、MicroVM内部から自身のIDを取得できる専用メタデータエンドポイントや環境変数は、現時点の公式ドキュメントに記載がない。

### 公式の取得方法: `/run` ライフサイクルフック

MicroVMが起動すると、Lambda はアプリケーションが公開するライフサイクルフックエンドポイントに POST リクエストを送信する。**`/run` フックのリクエストボディに `microvmId` が自動的に含まれる**。

```
POST /aws/lambda-microvms/runtime/v1/run
Content-Type: application/json

{
  "microvmId": "mvm-01234567-abcd-ef01-2345-6789abcdef01",
  "runHookPayload": "（RunMicrovm呼び出し時に渡した任意文字列）"
}
```

アプリケーションはこのフックを受け取った時点で `microvmId` をメモリに保持し、以降のロジック（自己サスペンド呼び出しなど）に利用する。

### 補足: RunMicrovm レスポンスでも取得できる

MicroVMを起動する呼び出し元（外部）では、RunMicrovm のレスポンスから `microvmId` を取得できる。

```json
{
  "microvmId": "mvm-01234567-abcd-ef01-2345-6789abcdef01",
  "endpoint": "https://...",
  "state": "PENDING",
  ...
}
```

`runHookPayload` パラメータを使えば、呼び出し元が取得した `microvmId` を MicroVM 内部に渡すことも可能だが、Lambda が `/run` フックに直接注入するため通常は不要。

### ListMicrovms のフィルタリング

image ARN や name でフィルタリングすることは可能。利用できるフィルタは以下の2つ。

| クエリパラメータ | 説明 |
|------------------|------|
| `imageIdentifier` | ARNまたはIDで対象イメージを絞り込む |
| `imageVersion` | イメージバージョンで絞り込む |

`name` フィールドによる直接フィルタはなく、MicroVM名の概念自体が現APIには存在しない（IDベースで識別する設計）。

---

## IAM パーミッション

すべてのアクション名は `lambda:` プレフィックス。リソース ARN フォーマットは次のとおり。

```
arn:aws:lambda:<region>:<account-id>:microvm:<microvm-id>
```

### 今回の調査対象アクション

| API | 必要なIAMアクション |
|-----|-------------------|
| SuspendMicrovm | `lambda:SuspendMicrovm` |
| ListMicrovms | `lambda:ListMicrovms` |

### 参考: MicroVM操作に関する全IAMアクション一覧

| IAMアクション | 説明 |
|---------------|------|
| `lambda:RunMicrovm` | MicroVM を新規起動する |
| `lambda:GetMicrovm` | MicroVM の状態・詳細を取得する |
| `lambda:ListMicrovms` | アカウント内の MicroVM を一覧取得する |
| `lambda:SuspendMicrovm` | 実行中の MicroVM をサスペンドする |
| `lambda:ResumeMicrovm` | サスペンド中の MicroVM を再開する |
| `lambda:TerminateMicrovm` | MicroVM を終了する |
| `lambda:CreateMicrovmAuthToken` | MicroVM への認証トークンを生成する |
| `lambda:CreateMicrovmShellAuthToken` | シェルアクセス用トークンを生成する |

### 最小権限ポリシー例（オペレーター向け）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:ListMicrovms",
        "lambda:SuspendMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken"
      ],
      "Resource": "arn:aws:lambda:*:123456789012:microvm:*"
    }
  ]
}
```

---

## 参考リンク

- [SuspendMicrovm API リファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_SuspendMicrovm.html)
- [RunMicrovm API リファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
- [ListMicrovms API リファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListMicrovms.html)
- [Running and using MicroVMs（ライフサイクルフック含む）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Security and permissions（IAMアクション一覧）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [boto3 リファレンス: suspend_microvm](https://docs.aws.amazon.com/boto3/latest/reference/services/lambda-microvms/client/suspend_microvm.html)
