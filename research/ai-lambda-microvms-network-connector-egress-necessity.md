# AWS Lambda MicroVMs の Network Connector(egress)要否調査

## デフォルトのegressネットワーク動作
AWS Lambda MicroVMsの公式ドキュメント(`microvms-networking.html`)には「By default, Lambda MicroVMs have public internet access on the egress path」と明記されている。すなわちMicroVMは通常のLambda関数と同様、`run-microvm`実行時に`--egress-network-connectors`を指定しなくても、デフォルトでパブリックインターネットおよびAWSサービスAPIエンドポイントへの到達性を持つ。コンソールの設定画面でも、Egress network connectorの選択肢は「Internet(デフォルト、パブリックインターネットアクセス)」と「ユーザーのVPCリソースへアクセスするネットワークコネクタ」の二択として案内されており、既定値は前者である。

DynamoDBとBedrock(InvokeModel)はいずれもVPC内リソースではなく、パブリックエンドポイントを持つAWSマネージドサービスAPIである。SQSのイベントソースマッピングもLambdaサービス側の制御プレーンがポーリングする仕組みであり、MicroVM自身がSQSへ能動的に到達する経路を持つ必要はない。したがって、このMicroVMワーカーの用途(SQS受信・DynamoDB書き込み・Bedrock呼び出しのみ)であれば、Network Connector(egress)を作成せず、デフォルト設定のまま運用することが公式ドキュメント上の記載と整合する。

## AWS管理コネクタの有無とVPC_EGRESSコネクタの要件
Ingress方向については「Ingress connectors are AWS-managed – you reference them by ARN when running a MicroVM」と明記があり、AWS管理の固定ARNコネクタが存在する。一方、egress方向でVPC内リソースへの到達性を持たせる場合は、ドキュメント上「create a Lambda Network Connector with your VPC configuration」とあるとおり、ユーザー自身がサブネットID・セキュリティグループID・ネットワークプロトコルを指定して`AWS::Lambda::NetworkConnector`(`VpcEgressConfiguration`)を作成する必要がある。AWSが用意する固定ARNのVPC egressコネクタは見当たらず、公式ドキュメントにもそのような記載はない。CDKコードのコメントにある認識(「決め打ちARNのAWS管理コネクタは存在しない」)は、調査した範囲のドキュメントと矛盾しない。

なお、VPC egressコネクタの作成にはLambdaがENIを作成するためのIAMロール(`OperatorRole`)が前提条件として必要と明記されている。CloudFormationのプロパティ定義上`OperatorRole`は`Required: No`だが、AWS CLIの作成例では`--operator-role`が必須パラメータのように使われており、CDKコードのコメントにある実行時エラー「NetworkConnectorOperatorRole is required for VPC_EGRESS connector type」は、スキーマ上の任意性とサービス側のバリデーションが一致しないケースとして把握しておくべき点である。

## VPC_EGRESSコネクタ使用時のNAT Gateway・VPCエンドポイント要否
`microvms-networking.html`には「When using VPC egress, outbound traffic is subject to security group rules and network ACLs governing traffic in your VPC」という記載はあるが、NAT GatewayやVPCエンドポイント(DynamoDB Gateway型、Bedrock Interface型)の要否について明示的な言及は見つからなかった。**この点はMicroVMs公式ドキュメントに記載がない。**

一般的なVPCネットワーキングの原則から類推すると、ENIにパブリックIPが付与されない限り、パブリックサブネットに配置しただけではインターネットゲートウェイ経由のegressは成立せず、NAT GatewayまたはVPCエンドポイントのいずれかが必要になると考えられる。ただし、これはMicroVMのNetworkConnectorが内部でどのようにENIを構成するかに依存する一般論であり、MicroVMs固有の挙動として公式ドキュメントで確認できたわけではない。断定はできない。

## SQS/DynamoDB/Bedrockのみを利用する場合の推奨構成
MicroVMs公式ドキュメントは、VPC egressコネクタの用途を「RDS、ElastiCache、内部API、Direct Connect/VPN経由のオンプレミスシステムへの接続」と例示しており、DynamoDBやBedrockのようなAWSサービスAPIはこの例示に含まれていない。これは裏を返せば、VPC内に存在しないAWSサービスAPIのみへのアクセスが目的であればVPC egressコネクタは不要であり、デフォルトのInternet egressで十分であることを示唆している。ただし「DynamoDB/Bedrockのみが目的の場合はコネクタ不要」と直接的に述べた一文はドキュメント中に存在せず、上記の記載からの推論である点は明記しておく。

## ドキュメントで確認できなかった点
以下は公式ドキュメントの調査範囲では確認できなかった。無理な推測はせず、未確認として報告する。

- VPC_EGRESSコネクタ利用時に、NAT GatewayなしのパブリックサブネットのみでAWSサービスAPIへ到達可能かどうかの明示的な記載
- MicroVMs固有のENIがパブリックIPを持つか、Hyperplane型ENIと同様の挙動を取るかについての記載
- 「DynamoDB/Bedrockのみが目的ならNetwork Connector自体を作成不要」と直接述べた一文(記載から導かれる推論にとどまる)

## 参考リンク
- [Networking - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [AWS::Lambda::NetworkConnector - CloudFormation Template Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-networkconnector.html)
- [AWS::Lambda::NetworkConnector Config](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-networkconnector-config.html)
- [AWS::Lambda::NetworkConnector VpcEgressConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-networkconnector-vpcegressconfiguration.html)
- [Additional configuration (console help) - Lambda MicroVMs](https://docs.aws.amazon.com/help-panel/lambda/latest/console/lambda-microvm-create-networking.html)
- [Create network connector (console help) - Lambda MicroVMs](https://docs.aws.amazon.com/help-panel/lambda/latest/console/create-network-connector.html)
- [AWS Lambda FAQs](https://aws.amazon.com/lambda/faqs/)
