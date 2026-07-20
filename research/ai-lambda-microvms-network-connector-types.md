# AWS Lambda MicroVMs の Network Connector 種類調査

## Ingress側で選択可能なAWS管理コネクタ
公式ドキュメント(`microvms-networking.html`)には「Ingress connectors are AWS-managed – you reference them by ARN when running a MicroVM」と明記されており、Ingress方向はユーザーが独自にリソースを作成する仕組みではなく、AWSが提供する固定ARNのコネクタから選択する方式である。調査の結果、確認できたAWS管理Ingressコネクタは以下の3種類である。

- `ALL_INGRESS`(ARN例: `arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:ALL_INGRESS`) - `microvms-getting-started.html`および`microvms-launching.html`のサンプルコマンドで実際に使用されている。「Enables inbound HTTPS traffic to your MicroVM on all ports」と説明されており、MicroVMエンドポイントへの通常のHTTPS/WebSocket/gRPC/SSEトラフィックを許可する既定の選択肢である。
- `NO_INGRESS`(ARN例: `arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:NO_INGRESS`) - `microvms-launching.html`に「To disable ingress connectivity, use the Lambda-provided NO_INGRESS connector」と明記されている。Ingressコネクタを完全に無効化したい場合に使用する。
- `SHELL_INGRESS`(ARN例: `arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:SHELL_INGRESS`) - `microvms-security.html`および`microvms-troubleshooting.html`に記載があり、MicroVMへのシェルアクセス(`create-microvm-shell-auth-token`によるデバッグ用シェル接続)専用のコネクタである。このコネクタを指定せずに起動したMicroVMに対して`create-microvm-shell-auth-token`を呼び出すと`ValidationException`になると明記されている。

`--ingress-network-connectors`は配列指定(最大10件)であるため、`ALL_INGRESS`と`SHELL_INGRESS`を併用してデバッグ用シェルアクセスと通常のHTTPSトラフィック受信を両立させる、といった構成が可能とみられる。ただし複数コネクタを併用した場合の挙動の詳細な記載は見つからなかった。

## Egress側で選択可能なコネクタ
Egress方向は「AWS管理の既定コネクタ(1種類)」と「ユーザーが自分のVPC構成に基づいて作成するコネクタ(1種類)」の二層構造になっている。

- `INTERNET_EGRESS`(ARN例: `arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`) - AWS管理の固定ARNコネクタ。「By default, Lambda MicroVMs have public internet access on the egress path」とあるとおり、`--egress-network-connectors`を省略した場合と同じ挙動(パブリックインターネットアクセス)になる。明示的に指定することも、省略することも可能。
- `VPC_EGRESS`相当(ユーザー作成の`AWS::Lambda::NetworkConnector`、`VpcEgressConfiguration`) - RDS・ElastiCache・内部API・Direct Connect/VPN経由のオンプレミスシステムなど、ユーザーのVPC内リソースに到達させたい場合に使用する。詳細は次章を参照。

「NO_EGRESS」に相当するAWS管理コネクタは、調査した範囲のドキュメント(`microvms-networking.html`、`microvms-launching.html`、`microvms-getting-started.html`、`microvms-security.html`、`microvms-troubleshooting.html`)のいずれにも記載がなかった。Ingress側には明示的な無効化コネクタ(`NO_INGRESS`)が用意されている一方、Egress側の完全遮断オプションについては言及がない。**この点は未確認である。**

## ユーザー作成可能なカスタムNetworkConnector(`AWS::Lambda::NetworkConnector`)
CloudFormationリファレンス(`aws-resource-lambda-networkconnector.html`)を確認したところ、リソースのトップレベルプロパティは`Configuration`(必須)・`Name`(任意)・`OperatorRole`(任意)・`Tags`(任意)の4つのみであり、`Type`という名前の独立したプロパティは存在しない。コネクタの種別は`Configuration`(`Config`型)の中でどのサブ設定を指定するかによって決まる構造になっている。

`Config`型(`aws-properties-lambda-networkconnector-config.html`)を確認した結果、現時点でサブプロパティは`VpcEgressConfiguration`(必須)の1種類のみであり、Ingress用のカスタムサブ設定(例えば`VpcIngressConfiguration`のようなもの)は**CloudFormationリファレンス上に存在しない**。すなわち、ユーザーが`AWS::Lambda::NetworkConnector`リソースとして作成できるのは事実上「VPC egressコネクタ」のみであり、Ingress側のカスタムコネクタ作成手段は公式スキーマ上確認できなかった(Ingressは前章のAWS管理コネクタから選択する方式のみ)。

`VpcEgressConfiguration`(`aws-properties-lambda-networkconnector-vpcegressconfiguration.html`)のプロパティは以下のとおり。

- `AssociatedComputeResourceTypes`(必須、String配列、1〜1要素) - Allowed values: `MicroVm`のみ。現時点でMicroVM以外の値は許可されていない。
- `NetworkProtocol`(任意、String) - Valid Values: `IPv4` \| `DualStack`。
- `SecurityGroupIds`(任意、String配列、0〜5件) - 全てのセキュリティグループは指定サブネットと同一VPCに属する必要がある。
- `SubnetIds`(必須、String配列、1〜16件) - 全てのサブネットは同一VPCに属する必要がある。

コネクタ作成には`ec2:CreateNetworkInterface`・`ec2:CreateTags`権限を持つIAMロール(`OperatorRole`)が前提条件として必要であり、CFNスキーマ上`OperatorRole`は`Required: No`だが、`create-network-connector`のCLI例では`--operator-role`が実質必須パラメータのように使われている。

コネクタの状態遷移(`Fn::GetAtt State`で取得可能)は`PENDING`→`ACTIVE`→(`INACTIVE`/`FAILED`)→`DELETING`→(完了 or `DELETE_FAILED`)であり、`ACTIVE`状態でなければ`run-microvm`から参照できない。

なお、`microvms-networking.html`のコネクタ作成コマンド例では`aws lambda-core create-network-connector`というCLIコマンド名(サービスプレフィックス`lambda-core`)が使われており、`run-microvm`等が属する`lambda-microvms`サービスとは異なる名前空間になっている。`CreateNetworkConnector`単体のAPIリファレンスページの所在は今回のWeb検索では特定できなかった。**この点は未確認である。**

## `RunMicrovm`/`run-microvm`での指定形式
`API_RunMicrovm.html`のリクエストパラメータを確認した結果は以下のとおり。

- `ingressNetworkConnectors` - 型: 文字列配列。要素数0〜10件、各要素の長さ1〜2048文字。必須: No。
- `egressNetworkConnectors` - 型: 文字列配列。要素数0〜10件、各要素の長さ1〜2048文字。必須: No。

いずれも配列型であるため複数のコネクタARNを同時に指定できる(前述のとおりIngress側で`ALL_INGRESS`と`SHELL_INGRESS`を併用する使い方が想定される)。値の形式についてARN以外の許容値(名前のみ指定等)を示すパターン制約や列挙定義はAPIリファレンス上に記載がなく、`microvms-getting-started.html`等のサンプルは一貫してフルARN(`arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:{CONNECTOR_NAME}`、ユーザー作成コネクタの場合は`arn:aws:lambda:{region}:{account}:network-connector:{connector-id}`)を渡している。レスポンス側も同名・同型のフィールドで、指定した値がそのままエコーされる。

両パラメータとも省略可能であり、`egressNetworkConnectors`を省略した場合はデフォルトでパブリックインターネットアクセスとなる(=`INTERNET_EGRESS`相当)。`ingressNetworkConnectors`を省略した場合の既定挙動(Ingressが有効になるか無効になるか)についての明示的な記載は見つからず、**この点は未確認である。**

## コンソールのMicroVM作成画面での提示
コンソールヘルプページ(`lambda-microvm-create-networking.html`)には、Egress側の選択肢として「Internet(デフォルト、パブリックインターネットアクセス)」と「VPCネットワークコネクタ(ユーザーのVPCリソースへアクセス)」の二択が案内されている。これは`ai-lambda-microvms-network-connector-egress-necessity.md`の既存調査結果と一致する。

Ingress側について、コンソール上でどのような選択肢名(プルダウン項目名等)で`ALL_INGRESS`・`NO_INGRESS`・`SHELL_INGRESS`が提示されるかについては、当該ヘルプページに具体的な列挙が見当たらなかった。同様に`create-network-connector.html`ヘルプページにも、コンソールのコネクタ作成フォームにおける`Type`選択肢の詳細な記載はなかった。**この点は未確認である。**

## ドキュメントで確認できなかった点
以下は公式ドキュメントの調査範囲では確認できなかった。無理な推測はせず、未確認として報告する。

- Egress側に`NO_EGRESS`相当のAWS管理コネクタが存在するかどうか
- `ingressNetworkConnectors`省略時のデフォルト挙動(Ingressが有効か無効か)
- `CreateNetworkConnector`のAPIリファレンスページの所在、および`lambda-core`という CLIサービスプレフィックスの正式な位置づけ
- コンソールのMicroVM作成画面(Additional configuration)におけるIngressコネクタの具体的な選択肢表示名
- 複数のIngress/Egressコネクタを同一MicroVMに併用した場合の優先順位・競合時の挙動

## 参考リンク
- [Networking - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Create your first Lambda MicroVM - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html)
- [Running and using MicroVMs - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Security and permissions - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [Troubleshooting - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html)
- [RunMicrovm API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
- [AWS::Lambda::NetworkConnector - CloudFormation Template Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-networkconnector.html)
- [AWS::Lambda::NetworkConnector Config](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-networkconnector-config.html)
- [AWS::Lambda::NetworkConnector VpcEgressConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-networkconnector-vpcegressconfiguration.html)
- [Additional configuration (console help) - Lambda MicroVMs](https://docs.aws.amazon.com/help-panel/lambda/latest/console/lambda-microvm-create-networking.html)
- [Create network connector (console help) - Lambda MicroVMs](https://docs.aws.amazon.com/help-panel/lambda/latest/console/create-network-connector.html)
