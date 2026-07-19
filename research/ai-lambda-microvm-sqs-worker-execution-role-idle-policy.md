# AWS Lambda MicroVM: SQSロングポーリングワーカー構成の裏取り

## 1. アプリケーションコードがAWS SDK経由で他サービスを呼び出すためのIAMロール指定

`RunMicrovm` APIのリクエストボディには `executionRoleArn` パラメータが存在する。これは「MicroVMが実行中に引き受けるIAMロールのARN」であり、EC2のインスタンスプロファイルやLambda関数の実行ロールに相当するものである。型はString、パターンは `arn:aws[a-z\-]*:iam::[0-9]{12}:role/?[a-zA-Z_0-9+=,.@\-_/]+` で、Required指定はない（任意項目）。レスポンス（`RunMicrovmResponse`）にも同名の `executionRoleArn` が返却され、実際に引き受けられたロールを確認できる。

したがって、MicroVM内部のアプリケーションコードがAWS SDKでSQSの `ReceiveMessage` / `DeleteMessage` を呼び出す場合、`executionRoleArn` にSQS操作を許可するIAMロールを指定すればよい。

## 2. `IdlePolicy`による自動サスペンドの無効化

`IdlePolicy`オブジェクトは以下3つのメンバーで構成され、いずれも `IdlePolicy` を指定する場合はRequired: Yesである。

- `autoResumeEnabled`（Boolean）: サスペンド中にリクエストを受信した際、自動的に再開するかどうか
- `maxIdleDurationSeconds`（Integer、最小値60、上限の記載なし）: サスペンドされるまでのアイドル継続時間
- `suspendedDurationSeconds`（Integer、最小値0、上限の記載なし）: サスペンド状態から自動終了（Terminate）されるまでの継続時間

API仕様上、「自動サスペンドを完全にオフにする」ための専用フラグ（例: `disabled: true`）は**記載なし**。ただし以下2点から、実質的な無効化手段が読み取れる。

- `RunMicrovm`リクエストにおいて `idlePolicy` 自体はRequired: No（任意項目）であり、省略した場合の既定動作についての明記は**記載なし**。
- コンソールヘルプ「Idle policy」ページには「非同期でトラフィックを能動的に受信しないアプリケーションについては、自動サスペンドを無効化するか、適切なアイドル時間を設定してMicroVMの早期サスペンドを防止する」という記載があるが、これはコンソールUI上の操作案内であり、対応するAPIパラメータ名（`disabled`相当のキー等）は**記載なし**。

SQSロングポーリングワーカーのように「エンドポイントURLへのトラフィックがほぼ無い」構成では、`maxIdleDurationSeconds` にMicroVMの最大生存時間（`maximumDurationInSeconds`、最大28,800秒＝8時間）に近い値を設定することで、事実上サスペンドが発生しない運用は可能と考えられる。ただし、これが仕様として保証された「無効化」なのか、単なる回避策なのかはドキュメント上明確ではない。

## 参考リンク

- [RunMicrovm API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
- [IdlePolicy API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html)
- [Idle policy (console help)](https://docs.aws.amazon.com/help-panel/lambda/latest/console/lambda-microvm-create-idle-policy.html)
