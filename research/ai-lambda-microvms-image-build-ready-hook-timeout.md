# AWS Lambda MicroVMs のReady/Validateフックタイムアウトとegressネットワークコネクタの関係調査

## egressNetworkConnectorsの目的とビルド時フック呼び出しへの関与

`AWS::Lambda::MicrovmImage`の`EgressNetworkConnectors`プロパティ、および`CreateMicrovmImage` APIの`egressNetworkConnectors`は、公式リファレンスで「MicroVM実行時（runtime）に利用可能なegressネットワークコネクタの一覧」と定義されている。これはイメージから起動する`Microvm`が使用してよいコネクタの許可リストであり、実際の割り当ては`RunMicrovm`呼び出し時の`--egress-network-connectors`パラメータで行われる。

一方、Ready/Validateフックの呼び出し経路はこれとは別系統である。「MicroVM images」ページによれば、ビルドプロセスはLambdaが管理するビルド専用MicroVMを新規プロビジョニングし、その内部でDockerfileを実行してアプリを起動し、フックのHTTP応答を待ってからスナップショットを取得する、という一連の流れがLambdaのビルドオーケストレーター内部で完結する。これはコンテナ内から外部（インターネットやVPC）へ出ていく通信ではなく、Lambda側の制御プレーンからビルド中のMicroVM内のアプリへ向かう内向きの呼び出しであるため、`egressNetworkConnectors`（アウトバウンド専用の設定）が影響する経路ではない。なお「AWS Lambda MicroVMs core concepts」には「ビルド時とランタイム時でネットワークコネクタが異なりうる」という記述があるが、これはビルド中のアウトバウンド通信（パッケージ取得等）とランタイムのアウトバウンド通信を区別する文脈であり、フック呼び出し自体（インバウンド方向）の到達性とは別問題である。

結論として、`egressNetworkConnectors`の設定・削除がReady/Validateフックのタイムアウトを直接引き起こす可能性は低いと考えられる。

## 正しいARN形式と実在確認の方法

`aws-network-connector`名前空間のAWS管理コネクタ（`INTERNET_EGRESS`、`SHELL_INGRESS`、`NO_INGRESS`等）はAWS管理のBase Image ARN（`arn:aws:lambda:<region>:aws:microvm-image:al2023-1`）と同様の静的な命名規則を持つ、サービス側で固定提供されるリソースである。

コネクタの一覧・詳細確認APIは`aws-lambda-microvms`名前空間ではなく、別名前空間の`aws lambda-core`に存在する。

- `aws lambda-core list-network-connectors` — アカウント内のコネクタ一覧取得
- `aws lambda-core create-network-connector` / `get-network-connector` — 顧客管理VPCコネクタの作成・状態確認

ただしこれらは主に顧客が`create-network-connector`で作成したVPC egressコネクタ向けであり、AWS管理の静的コネクタ（`INTERNET_EGRESS`等）を列挙できるかは公式ドキュメント上で明言されていない。`get-network-connector --network-connector-identifier <ARN>`に該当ARNを渡して`ACTIVE`相当の応答が返るかで存在確認を試みるのが現実的である。デフォルトでは`egressNetworkConnectors`を省略してもMicroVMはパブリックインターネットへ到達可能なため、当該ARNを決め打ちで使う必然性自体を疑うべきである。

## Ready/Validateフックが「到達しない」典型的な原因

ドキュメント上、`/ready`・`/validate`フックは固定パス（`/aws/lambda-microvms/runtime/v1/ready`、`/aws/lambda-microvms/runtime/v1/validate`）に対してLambda側が`hooks.port`で指定したポートへHTTPリクエストを送る仕組みである。CloudFormationの`MicrovmImageHooks.Ready`プロパティは値として`ENABLED`/`DISABLED`のみを受け付け、任意のカスタムパスを指定するものではない。したがって、アプリケーションのメインエンドポイント（例: `/`のみ、または独自のヘルスチェックパス）だけを実装していて、この固定パスへのリクエストに対して200/503以外（典型的には404）を返している場合、Lambda側は「未Ready」と判定し続け、指定タイムアウトまでリトライを繰り返した末に失敗する。ユーザー環境で「コンテナはport 8080でlisteningログを出すが、300秒に延長してもタイムアウトする」という症状は、ネットワーク到達性の問題よりも、この固定パスのハンドラ未実装、または200を返すべきタイミングでの実装漏れによる可能性が高い。

また、トラブルシューティングガイドには「フックサーバーは`0.0.0.0`にバインドする必要があり、`127.0.0.1`のみのリスンはLambdaのフック呼び出し元から到達不能」という既知の制約が明記されている。`listening on port 8080`のログだけでは、どのアドレスにバインドしているか（`0.0.0.0`か`127.0.0.1`か）は判別できない。

VPC設定によるフック呼び出し経路の遮断については、フック呼び出しがビルドオーケストレーターからビルド中MicroVM内部への呼び出しである以上、`egressNetworkConnectors`の有無・設定ミスによって遮断されるという記述は見当たらなかった。

## "did not stabilize" / "Ready hook invocation timed out" の既知情報

Lambda MicroVMsは2026年6月に発表されたばかりのプレビュー機能であり、re:PostやGitHub（aws-cdk、aws-samples等）上に本機能固有の既知issueは見当たらなかった。一般的なCloudFormationの"did not stabilize"エラーは、リソースの作成コールバックがタイムアウトした場合に発生する汎用メッセージであり、原因はサービスごとに異なる。公式のMicroVMs専用トラブルシューティングリファレンスには、ビルド失敗時の`stateReason`一覧（`S3_ACCESS_DENIED`、`CONTAINER_BUILD_FAILED`、`INTERNAL_PLATFORM_ERROR`等）と、CloudWatch Logs（`/aws/lambda-microvms/<image-name>`）でのフックサーバー側スタックトレース確認手順が案内されているのみで、"Ready hook invocation timed out"という文言そのものへの言及は見つからなかった。

## 次に試すべき切り分け手順

1. `aws lambda-microvms list-microvm-image-builds --image-identifier <image> --image-version <n>`で`stateReason`を確認する。
2. CloudWatch Logsグループ`/aws/lambda-microvms/<image-name>`で、固定パス`/aws/lambda-microvms/runtime/v1/ready`へのリクエストをアプリが受信・応答しているか（404を返していないか）を確認する。
3. アプリのヘルスチェック/ルーティング実装に、固定パスに対する明示的なハンドラ（未Ready時は503を即時返す、Ready時は200を返す）を追加し、`hooks.port`で指定したポートで待ち受けているか、`0.0.0.0`バインドになっているかを確認する。
4. 上記で解決しない場合、`egressNetworkConnectors`を一旦外し、デフォルトのパブリックインターネットegressのみでビルドが通るか切り分ける。
5. それでも再現する場合は、プレビュー機能かつ情報が乏しいため、CloudWatch Logsの該当ログ抜粋とCloudFormationスタックイベントを添えてAWSサポートケースを開くことを推奨する。

## 参考リンク
- [AWS introduces Lambda MicroVMs for isolated execution of user and AI-generated code](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/)
- [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [MicroVM images (build hooks)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Networking - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [AWS::Lambda::MicrovmImage MicrovmImageHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmimagehooks.html)
- [CreateMicrovmImage API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html)
- [list-network-connectors — AWS CLI Reference (lambda-core)](https://docs.aws.amazon.com/cli/latest/reference/lambda-core/list-network-connectors.html)
