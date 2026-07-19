# AWS Lambda MicroVMs をS3アップロードトリガーで起動するプロトタイプ設計調査

## 概要

AWS Lambda MicroVMsは、Firecracker技術によるVMレベルの分離とスナップショットからの高速起動・再開を特徴とする新しいサーバーレスコンピュートプリミティブである。既存のLambda関数（FaaS）とはAPI・リソース体系が完全に分離されており、S3イベント通知から直接起動することはできない。本調査では、S3アップロードをトリガーにMicroVMを制御するプロトタイプ設計に必要な裏取り事項を整理する。

## 1. APIオペレーション一覧と同期/非同期特性

MicroVMsは`lambda-microvms`という独立したAPI名前空間（クライアント）を持ち、通常のLambda API（`CreateFunction`/`Invoke`等）とは別系統である。

- `CreateMicrovmImage`／`UpdateMicrovmImage`：非同期。イメージは`CREATING`から`CREATED`（または`CREATE_FAILED`）へ遷移し、`GetMicrovmImage`でポーリングする。
- `RunMicrovm`：非同期。応答時点で`PENDING`状態を返し、内部でスナップショットから復元後`RUNNING`に遷移する。状態は結果整合性があり、確実な起動確認はエンドポイントへの疎通で行う。
- `SuspendMicrovm`／`ResumeMicrovm`：非同期。それぞれ`SUSPENDING`→`SUSPENDED`、`SUSPENDED`→`RUNNING`の中間状態を経由する。
- `TerminateMicrovm`：`TERMINATING`→`TERMINATED`に遷移。
- `GetMicrovm`／`GetMicrovmImage`／`ListMicrovms`／`ListMicrovmImages`：同期の参照系API。
- `CreateMicrovmAuthToken`／`CreateMicrovmShellAuthToken`：MicroVMのHTTPSエンドポイント（または対話シェル）にアクセスするための認証トークンを発行する同期API。
- `DeleteMicrovmImage`／`DeleteMicrovmImageVersion`：冪等な削除API。

## 2. S3イベント通知からの直接起動の可否

S3バケット通知（`put-bucket-notification-configuration`の`LambdaFunctionConfiguration`）は、`lambda_function_arn`に指定できるのは通常のLambda関数ARN（`arn:aws:lambda:<region>:<account>:function:<name>`）のみである。MicroVMイメージのARNはリソースタイプが`microvm-image`（例：`arn:aws:lambda:<region>:<account>:microvm-image:<name>`）であり、実行中インスタンス（Microvm）はCloudFormation/S3通知の対象となるリソースとしてそもそも存在しない。したがって、S3イベント通知でMicroVMを直接destinationに指定する経路は確認できなかった（ドキュメント上もそのような記載はない）。

標準的な連携方法として、`aws-lambda-microvms`スキルのガイダンスでは以下の使い分けが明記されている。

- イベントソース連携（S3、SQS、EventBridge等）で駆動する処理は通常のLambda関数を使う。
- 強い分離・長時間セッション・状態保持が必要な処理はMicroVMsを使う。

この記載から、実務上は「S3イベント通知→通常のLambda関数→当該Lambda関数内でSDK経由`RunMicrovm`（または`ResumeMicrovm`）を呼び出し、MicroVMのエンドポイントにHTTPSリクエストを送る」という2段構成が標準パターンとなる。EventBridge経由でAPI宛先を直接呼ぶ機構については、ドキュメント上に明記なし。

## 3. Lambda関数としてのARN互換性

MicroVMは通常のLambda関数のInvoke経路（`lambda:InvokeFunction`）を使用しない。`RunMicrovm`で起動すると、専用のTLS終端HTTPSエンドポイント（`<microvm-id>.lambda-microvm.<region>.on.aws`形式）が発行され、クライアントは`X-aws-proxy-auth`ヘッダーに認証トークンを付与して直接HTTPSで通信する。ARN体系・呼び出しAPI・認証方式のいずれも通常のLambda関数とは別物であり、S3のLambdaFunctionConfigurationにMicroVM関連ARNを指定することはできない。

## 4. 起動・実行時間の制約

- 最大存続時間：`--maximum-duration-in-seconds`で指定し、範囲は1〜28,800秒（8時間）。RUNNING/SUSPENDED状態を合わせた総時間がこれを超えると強制終了される。
- 起動・再開時間：ドキュメント上は「near-instant launch and resume（近瞬時の起動・再開）」という定性的な表現のみで、具体的なミリ秒/秒単位の数値は記載なし。再開遅延はスナップショット状態のサイズと`/resume`フックの処理時間に依存すると説明されている。
- 認証トークンの有効期限は最大60分（`CreateMicrovmAuthToken`／`CreateMicrovmShellAuthToken`共通）。

## 5. 課金モデル

Lambda FAQ及びLambda MicroVMs製品ページによると、課金は次の3軸で構成される。

1. コンピュート：稼働中（RUNNING）にベースライン/ピーク使用量に応じて秒単位課金。ベースラインからピーク（最大4倍）まで垂直スケール可能で、ベースラインを超えた分は実使用量課金。
2. スナップショット操作・ストレージ：SUSPENDED中はコンピュート課金は発生せず、スナップショットの保存料金のみ発生する。
3. データ転送。

すなわち通常のLambda関数（リクエスト数＋実行時間のGB秒課金）とは異なり、MicroVMsは「稼働中は秒課金、休止中はストレージのみ課金」という保持型の課金モデルである。

## 6. IAMで必要な権限

`docs.aws.amazon.com/lambda/latest/dg/microvms-security.html`に列挙されているIAMアクションは以下の通り。

- `lambda:CreateMicrovmImage`／`lambda:UpdateMicrovmImage`／`lambda:DeleteMicrovmImage`／`lambda:GetMicrovmImage`／`lambda:ListMicrovmImages`：イメージのライフサイクル管理。
- `lambda:RunMicrovm`／`lambda:GetMicrovm`／`lambda:ListMicrovms`／`lambda:SuspendMicrovm`／`lambda:ResumeMicrovm`／`lambda:TerminateMicrovm`：MicroVM本体のライフサイクル制御。
- `lambda:CreateMicrovmAuthToken`／`lambda:CreateMicrovmShellAuthToken`：エンドポイント・シェルアクセス用トークン発行。

このほか、スキルの補足情報として`lambda:PassNetworkConnector`（ネットワークコネクタの受け渡し）が必要になる場合がある旨の記載がある（詳細な条件はドキュメント原文で要確認）。

## 7. CDK/CloudFormationのサポート状況

CloudFormationテンプレートリファレンスの更新履歴（2026年6月22日付）に、新規リソースとして`AWS::Lambda::MicrovmImage`と`AWS::Lambda::NetworkConnector`が追加されたことが明記されている。CDKでも`aws-cdk-lib.aws_lambda.CfnMicrovmImage`（L1、cdk-lib 2.261.0時点で確認）が存在する。

- サポート済み：MicroVMイメージ（`MicrovmImage`）とネットワークコネクタは、CloudFormation L1相当のリソースおよびCDKのL1コンストラクト（`CfnMicrovmImage`）としてIaCで宣言的に管理できる。
- 未確認/記載なし：実行中のMicroVMインスタンス自体（`RunMicrovm`で生成される`Microvm`）に対応するCloudFormationリソースタイプ、およびCDKのL2高レベルコンストラクトは、調査時点のドキュメント上で見つからなかった。MicroVMの起動・停止は本質的に一時的（エフェメラル）な実行時操作であり、スタックが状態管理するリソースというよりAPI呼び出しで制御するランタイム操作である可能性が高い。

## 8. 想定ユースケース（イベント駆動処理との適合性）

AWS Lambda公式ドキュメント（Developer Guide）およびFAQ、AWS News Blogのいずれにおいても、MicroVMsの主眼は「対話的・セッション型」のユースケースであると明記されている。

- 想定ユースケースとして列挙されているのは、対話型コード実行環境、AIコード実行サンドボックス、データ分析（Jupyterノートブック等）、脆弱性スキャン、強化学習環境、マルチテナントCI/CD実行、ゲームサーバーである。
- ドキュメント中には「Functions as a serviceはイベント駆動・リクエストレスポンス型のワークロードに最適化されているが、セッション状態を保持し続ける長時間の対話セッションには向いていない」という趣旨の記載があり、これは裏を返せばMicroVMs自体が長時間セッション・状態保持を主眼としていることを示している。
- 一方、`aws-lambda-microvms`スキルのガイダンスでは「S3、SQS、EventBridge等のイベントソース連携で駆動される処理は通常のLambda関数を選ぶべき」と明記されており、MicroVMsをイベントソースマッピングの直接ターゲットとして使う設計は公式に推奨されていない。

以上より、S3アップロードをトリガーにした非同期バッチ処理そのものをイベント駆動処理としてMicroVMsに直接担わせる用途は、ドキュメント上「不向き」と明示されているわけではないが、標準アーキテクチャとしては推奨されていない。実務的には「S3イベント→通常のLambda関数→MicroVM起動・処理指示」という橋渡し構成が妥当である。

## プロトタイプ設計への示唆

調査結果を踏まえ、S3アップロードトリガー型プロトタイプは以下のステップで設計するのが妥当と考えられる。

1. S3バケットにオブジェクト作成イベント（`s3:ObjectCreated:*`）の通知を設定し、宛先を通常のLambda関数とする（`LambdaFunctionConfiguration`はMicroVMを直接指定できないため）。
2. その仲介Lambda関数に`lambda:RunMicrovm`（既存MicroVMを再利用する場合は`lambda:ResumeMicrovm`）と`lambda:CreateMicrovmAuthToken`のIAM権限を付与する。
3. 仲介Lambda関数がS3イベントのオブジェクトキー等を`--run-hook-payload`（最大16KB）としてMicroVMに渡し、MicroVM側の`/run`フックで処理を開始する。
4. 処理完了後は`idlePolicy`（`maxIdleDurationSeconds`等）による自動サスペンドを活用し、コンピュート課金を抑える。
5. MicroVMイメージ自体（`CfnMicrovmImage`）はCDK/CloudFormationで宣言的にプロビジョニングし、実行時の起動・サスペンド制御はSDK呼び出しで行う。

## 参考リンク

- [AWS Lambda MicroVMs（Developer Guide）](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [Security and permissions（IAMアクション一覧）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [MicroVM images（サイズ・課金構成）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Create your first Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html)
- [AWS Lambda MicroVMs API Reference（RunMicrovm等）](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html)
- [AWS Lambda – FAQs（課金・ユースケース）](https://aws.amazon.com/lambda/faqs/)
- [AWS Lambda Pricing（MicroVMs料金例）](https://aws.amazon.com/lambda/pricing/)
- [AWS CloudFormation Template Reference 更新履歴（AWS::Lambda::MicrovmImage追加）](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/doc-history.md)
- [Run isolated sandboxes with full lifecycle control: AWS Lambda introduces MicroVMs（AWS News Blog）](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
