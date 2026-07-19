# AWS Lambda MicroVMs のIAM信頼ポリシー・認証情報取得・ネットワーク到達性調査

## 実行ロール・ビルドロールの信頼ポリシー
`RunMicrovm`の`executionRoleArn`、および`CreateMicrovmImage`の`build-role-arn`で指定するIAMロールは、いずれも標準的なLambda関数と同じ信頼ポリシーを使用する。MicroVMs専用のサービスプリンシパルは存在しない。

具体的には、両ロールとも信頼ポリシーのPrincipalに`lambda.amazonaws.com`を指定し、`sts:AssumeRole`に加えて`sts:TagSession`アクションを許可する必要がある。ビルドロールは画像作成時（`/ready`・`/validate`フックの実行時）に、実行ロールはMicroVM実行時（`/run`・`/resume`・`/suspend`・`/terminate`フックの実行時）にそれぞれ使用される。両ロールともオプション指定であり、未指定の場合はビルドログ・実行ログがCloudWatchに出力されず、実行ロール未指定時はMicroVM内から他のAWSサービスへアクセスできない。

## MicroVM内部からの認証情報取得方法
`executionRoleArn`で指定したロールの認証情報を、MicroVM内部のアプリケーションコード（boto3等）がどう取得するかについて、`microvms-security.html`・`microvms-networking.html`・`microvms-launching.html`のいずれにも明記がなかった。ECSタスクロールのような`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`環境変数や、EC2の`169.254.169.254`のようなIMDS相当のメタデータエンドポイントに関する記載は見つからなかった。ドキュメント上の言及は「実行ロールはランタイム時にCloudWatchへのログ書き込みや他サービス利用のアクセス許可を提供する」という抽象的な説明に留まる。SDKサンプルコードも、MicroVMを起動・接続する制御プレーン側（`boto3.client("lambda-microvms")`によるRunMicrovmやトークン発行）の例のみで、MicroVM内部のアプリ側コードが認証情報を取得するコード例は掲載されていない。**この点は記載なし。**

## Ingress/Egressネットワークコネクタの最小構成
`run-microvm`の`--egress-network-connectors`は省略可能であり、指定しない場合MicroVMはデフォルトでパブリックインターネットへの送信アクセスを持つ。AWS管理の`INTERNET_EGRESS`コネクタ（ARN例: `arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`）を明示的に指定した場合も同様にパブリックインターネット経路となる。SQS・S3・DynamoDB・Bedrockはいずれもパブリックエンドポイントを持つため、これらへのアウトバウンド到達には`INTERNET_EGRESS`（またはコネクタ省略によるデフォルト設定）で十分である。

顧客管理VPC経由のegressコネクタが必要になるのは、RDS・ElastiCacheなどプライベートVPC内リソースや、Direct Connect/VPN経由のオンプレミスシステムに接続するケースに限定されると明記されている。VPCエンドポイント経由が必須となる条件（例: アカウントポリシーでインターネット経路を禁止する場合等）については当該ページに具体的な言及はなかった。

`--ingress-network-connectors`は受信方向の設定であり、アウトバウンド到達性には直接関係しない。無効化する場合はAWS管理の`NO_INGRESS`コネクタを使用する。

## 参考リンク
- [Security and permissions - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [Networking - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Running and using MicroVMs - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [RunMicrovm API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
