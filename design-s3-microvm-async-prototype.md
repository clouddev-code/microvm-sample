# S3トリガー非同期処理プロトタイプ設計（AWS Lambda MicroVMs / SQSワーカー方式）

## 0. 結論

**可能。** S3のオブジェクトアップロードをSQSキューへのネイティブなイベント通知連携（Lambda不要）で受け、
起動済みのAWS Lambda MicroVM自身がそのSQSキューをロングポーリングしてメッセージが来たら処理する、
というワーカー型の非同期処理プロトタイプを構築できる。

```
S3 Bucket ──(s3:ObjectCreated:* イベント通知。ネイティブ連携・Lambda不要)──▶ SQS Queue
                                                                              │
                                                                              │ ロングポーリング
                                                                              ▼
                                                            AWS Lambda MicroVM（常駐ワーカー）
                                                              - executionRoleArn でSQS権限を保持
                                                              - 受信 → S3オブジェクト処理 → メッセージ削除
```

「S3→SQS」はS3の標準ネイティブ機能であり追加コンピュートは不要。MicroVM内部のアプリケーションコードが
`executionRoleArn`で引き受けたIAMロールを使いAWS SDK経由でSQSを直接呼び出すため、
イベントの検知・消費（受信→削除）の実処理はMicroVM側だけで完結する。

## 1. 確認済みの重要事実

| 項目 | 内容 |
|---|---|
| S3→SQS連携 | S3バケット通知設定でSQSキューを直接destinationにできる（Lambda不要のネイティブ機能） |
| MicroVMの実行ロール | `RunMicrovm` APIに任意パラメータ`executionRoleArn`があり、指定したIAMロールをMicroVMが引き受ける。EC2インスタンスプロファイル/Lambda実行ロールに相当し、内部コードがSDK経由で他のAWSサービスを呼べる |
| アイドル判定 | `IdlePolicy`はMicroVMの**インバウンドHTTPプロキシエンドポイントへのトラフィックのみ**で計測される。SQSへのアウトバウンドポーリングは活動とみなされない点に注意 |
| アイドルポリシーの構成 | `autoResumeEnabled`（bool）／`maxIdleDurationSeconds`（最小60秒、上限記載なし）／`suspendedDurationSeconds`（最小0秒）。専用の「完全無効化」フラグは仕様上明記なし |
| 最大稼働時間 | `maximumDurationInSeconds`は1〜28,800秒（8時間）。超過時はSUSPENDではなく強制TERMINATE |
| 配信保証 | S3→SQSもat-least-once・順序保証なし。処理の冪等性実装が必須 |

## 2. アーキテクチャ詳細

### 2.1 S3バケット + SQSキュー（CDK, 標準機能のみ）

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';

const queue = new sqs.Queue(this, 'UploadQueue', {
  visibilityTimeout: cdk.Duration.seconds(300), // 処理時間に応じて調整
});

const bucket = new s3.Bucket(this, 'UploadBucket');
bucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(queue),
  { prefix: 'uploads/' },
);
```

- SQSキューのアクセスポリシーは`addEventNotification`が自動でS3からの`sqs:SendMessage`を許可する条件（`aws:SourceArn`＝バケットARN）を設定する。
- `visibilityTimeout`はMicroVM側の1メッセージあたりの処理時間より十分長く設定する（処理中に他ワーカーへ再配信されるのを防ぐ）。

### 2.2 MicroVMの起動設定

`RunMicrovm`呼び出し時に以下を指定する。

- `executionRoleArn`: SQSキューに対する`sqs:ReceiveMessage`／`sqs:DeleteMessage`／`sqs:GetQueueAttributes`と、対象S3バケットへの`s3:GetObject`を許可したIAMロール。
- `idlePolicy.maxIdleDurationSeconds`: SQSポーリングはインバウンド活動として計測されないため、意図しない自動サスペンドを避けるには最大稼働時間（8時間）に近い値を設定するか、`idlePolicy`自体を省略する（省略時の既定挙動は要動作確認）。
- `maximumDurationInSeconds`: 最大28,800秒（8時間）。この上限に達すると強制終了されるため、**8時間ごとにMicroVMを再起動する運用が必須**（後述）。

### 2.3 MicroVM内ワーカーコード（設計イメージ）

```
loop:
  messages = sqs.receive_message(QueueUrl, WaitTimeSeconds=20, MaxNumberOfMessages=10)
  for message in messages:
      s3_event = parse(message.body)              # S3イベント通知のJSON
      key = s3_event.Records[0].s3.object.key
      obj = s3.get_object(Bucket, key)
      process(obj)                                 # 冪等な処理（ETag/VersionIdでdedupe）
      sqs.delete_message(QueueUrl, message.receipt_handle)
```

- SQS標準キューはat-least-once配信のため、`process()`は同一オブジェクトを複数回処理しても副作用が出ないよう冪等に実装する（例: 処理済みキーをオブジェクトのETag単位で記録・チェック）。
- 実行ロール(`executionRoleArn`)経由でAWS SDKの認証情報が自動的に得られる想定（EC2インスタンスプロファイル相当の挙動）。

### 2.4 8時間ライフサイクルの運用

MicroVMは最大8時間で強制終了されるため、恒久的なワーカーとしては以下のいずれかの運用が必要。

- 軽量な起動係（EventBridge Schedulerで7〜8時間ごとに1回だけ動く小さなLambda関数、またはオペレーター手動実行）が`RunMicrovm`を呼び直し、後継のMicroVMを起動する。
- こちらのLambda関数はイベント検知・処理そのものには関与せず、**MicroVMのライフサイクル管理専任**とすることで、「S3イベントの検知・処理はMicroVMのみで完結させる」という狙いを実質的に満たす設計にする。

## 3. IAM権限まとめ

**MicroVMの`executionRoleArn`（内部ワーカーコードが使用）:**
- `sqs:ReceiveMessage` / `sqs:DeleteMessage` / `sqs:GetQueueAttributes`（対象キューのみ）
- `s3:GetObject`（対象バケットのみ）

**MicroVMライフサイクル管理用Lambda関数（8時間ごとの再起動係）の実行ロール:**
- `lambda:RunMicrovm` / `lambda:GetMicrovm` / `lambda:ListMicrovms`

## 4. CDK/CloudFormationサポート状況

- S3→SQS通知、SQSキュー自体はCDK/CloudFormationで完全にネイティブサポートされ、宣言的に管理可能。
- MicroVMイメージ（`CfnMicrovmImage`）はL1コンストラクトで宣言的管理可能。
- MicroVMインスタンスの起動（`RunMicrovm`）・ライフサイクル制御はCDK/CloudFormationのリソースとして存在せず、SDK呼び出し（前述の軽量Lambda関数、または初回のみの手動CLI実行）で行う。

## 5. 未確定・要検証事項

- `IdlePolicy`を完全に無効化する専用フラグがAPI仕様上見当たらなかった。`maxIdleDurationSeconds`を大きく設定する回避策が仕様上保証された挙動かは実機検証が必要。
- MicroVM起動・再開の具体的なレイテンシ（ミリ秒/秒単位）は「near-instant」という定性表現のみで、実測値は実機検証が必要。
- `executionRoleArn`経由の認証情報がMicroVM内でどのように取得できるか（EC2同様のインスタンスメタデータサービス経由か等）の具体的な実装方法はAPIリファレンス上の言及のみで、実機でのSDK動作確認が推奨される。

## 6. 参考リンク

- [AWS Lambda MicroVMs (Developer Guide)](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [RunMicrovm API Reference（executionRoleArn含む）](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
- [IdlePolicy API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html)
- [Security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [MicroVMs networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [S3 User Guide - イベント通知タイプと送信先](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html)
- [S3→SQS CDK: SqsDestination](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_notifications.SqsDestination.html)
- 一次調査ログ:
  - `research/ai-lambda-microvms-s3-trigger.md`
  - `research/ai-lambda-microvm-sqs-worker-execution-role-idle-policy.md`
