# Lambda関数のネットワーク構成: DynamoDB/Bedrockのみ利用する場合のVPCアタッチ要否

## 調査背景

VPCサブネットにアタッチされ、Hyperplane ENI経由でVPC-to-VPC NAT接続する構成(いわゆる"VPCコネクタ")のLambda関数が、DynamoDBとBedrockという2つのAWSマネージドサービスAPIのみにアクセスしている。VPC設定を外し、AWSマネージドネットワーク経由の直接アクセスに切り替えて問題ないかを判断する。

## VPC非接続Lambdaのデフォルト到達性

Lambda関数はVPCにアタッチしない限り、AWS Lambdaサービスが管理する内部VPC上で実行され、デフォルトでパブリックインターネットおよびAWSサービスAPIエンドポイントに到達可能である。AWS公式ブログ「Building AWS Lambda governance and guardrails」では、Lambda間の内部AWSトラフィックはインターネットを経由せずAWS Global Backboneを使用するため、AWSサービスへの接続のみが目的であればVPCへの接続は不要と明記されている。認証・認可はIAM実行ロールおよびリソースポリシーで行われるため、送信元IPアドレスによるアクセス制限は通常不要である(IPベースの制御を追加したい場合はIAMポリシー条件キー`aws:SourceIp`等で代替可能だが、DynamoDB/Bedrockではロールベースの認可が標準)。

## LambdaをVPCにアタッチする一般的な理由

VPCアタッチが必要になるのは、主に以下のようなケースに限られる。

- RDS、ElastiCache、EC2などVPC内にのみ存在するプライベートリソースへ直接接続する必要がある場合
- セキュリティグループやネットワークACLによる通信制御、VPC Flow Logsによる監査など、ネットワークレベルでの統制要件がある場合
- すべての通信をプロキシ/ファイアウォール経由で検査する、あるいは全通信をVPC経由に強制するコンプライアンス要件がある場合
- VPCリンクを介したAPI Gatewayなど、VPC内でのみ到達可能なAWSリソースを利用する場合

AWS公式ブログ「Operating Lambda: Application design」は、これらのケース以外では「VPC設定を追加しても利益はない("no additional benefit")」と明言している。

## VPCアタッチのデメリット・コスト

VPCにアタッチしたLambda関数は、デフォルトではインターネットにもAWSパブリックサービスエンドポイントにも到達できなくなる。到達性を確保するには以下いずれかが必要になる。

- パブリックサブネットのNAT Gatewayを経由したインターネットルーティング(NAT Gatewayは時間課金+データ処理料金が発生し、可用性のため複数AZ配置が推奨されるためコストが積み上がる)
- VPCエンドポイント(PrivateLink)の追加設定(DynamoDB用Gateway型、Bedrock用Interface型をそれぞれ用意する必要があり、Interfaceエンドポイントは時間課金+データ処理料金が発生する)

コールドスタートについては、2019年のAWS Hyperplaneアーキテクチャ刷新以降、ENIの作成・アタッチが関数作成時/VPC設定変更時に事前実行されるようになったため、呼び出し時の遅延は大幅に改善されている。ただし、セキュリティグループ・サブネットの組み合わせごとにHyperplane ENIが必要であり、アカウントあたりENIには350の緩やかな上限があるなど、運用上の管理項目は増える。VPCエンドポイント、ルートテーブル、セキュリティグループの追加設定・保守も運用複雑性の増加要因となる。

## DynamoDBとBedrockのVPCエンドポイントサポート状況

| サービス | エンドポイント種別 | 課金 | 備考 |
| --- | --- | --- | --- |
| DynamoDB | Gateway型(推奨)およびInterface型(PrivateLink)の両方をサポート | Gateway型は無料、Interface型は課金対象 | Gateway型はルートテーブルに指定してAWSネットワーク経由でアクセス。オンプレミスや他リージョンからのアクセスが必要な場合のみInterface型を検討 |
| Bedrock | Interface型(AWS PrivateLink)のみをサポート | 課金対象(時間課金+データ処理料金) | インターネットゲートウェイ・NATデバイス・VPN・Direct Connectなしで専用の接続を確立 |

VPCアタッチを維持する場合、DynamoDBは無料のGatewayエンドポイントで済むが、BedrockはInterfaceエンドポイントの追加コストが発生する。

## ベストプラクティスとしての推奨

AWS公式ドキュメント「Giving Lambda functions access to resources in an Amazon VPC」およびAWS Lambda FAQでは、VPC内のプライベートリソースへのアクセスが不要な場合、VPCへの接続は不要であると案内されている。AWS Compute Blogでも同様に、VPC内リソースにアクセスしない限りVPC設定に追加の利益はないと明記されている。一方でAWS Security Hubのドキュメントは、セキュリティの多層防御・ネットワーク分離の観点から一般論としてVPC内配置を推奨する記述もあり、コンプライアンス要件がある場合はこの限りではない。

## 結論(判断材料)

対象Lambda関数のアクセス先がDynamoDBとBedrockという2つのAWSマネージドサービスAPIのみであり、IAMロールによる認可で完結し、VPC内のプライベートリソースへの直接アクセスやネットワークレベルの通信検査・コンプライアンス要件がないのであれば、VPC設定を外してデフォルト(VPC非接続)構成に戻すことは技術的に妥当であり、AWSのガイダンスとも整合する。VPCコネクタを維持する主な動機が「セキュリティ強化」であれば、VPC非接続でもIAMロールの最小権限化・リソースポリシーでの制御・Bedrockガードレール等で同等以上の統制が可能かを併せて検討するとよい。VPCを維持する場合は、DynamoDB用Gateway VPCエンドポイント(無料)とBedrock用Interface VPCエンドポイント(課金)の設置、または NAT Gateway経由のインターネットアクセスが必須となる。

## 参考リンク

- [Giving Lambda functions access to resources in an Amazon VPC](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
- [Troubleshoot networking issues in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/troubleshooting-networking.html)
- [AWS Lambda FAQs](https://aws.amazon.com/lambda/faqs/)
- [Building AWS Lambda governance and guardrails | AWS Compute Blog](https://aws.amazon.com/blogs/compute/building-aws-lambda-governance-and-guardrails/)
- [Operating Lambda: Application design – Part 3 | AWS Compute Blog](https://aws.amazon.com/blogs/compute/operating-lambda-application-design-part-3/)
- [Using AWS Lambda IAM condition keys for VPC settings | AWS Compute Blog](https://aws.amazon.com/blogs/compute/using-aws-lambda-iam-condition-keys-for-vpc-settings/)
- [Announcing improved VPC networking for AWS Lambda functions | AWS Compute Blog](https://aws.amazon.com/blogs/compute/announcing-improved-vpc-networking-for-aws-lambda-functions/)
- [AWS PrivateLink for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/privatelink-interface-endpoints.html)
- [Gateway endpoints for Amazon DynamoDB](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-ddb.html)
- [Use interface VPC endpoints (AWS PrivateLink) to create a private connection between your VPC and Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)
- [Remediating exposures for Lambda functions | Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/exposure-lambda-function.html)
