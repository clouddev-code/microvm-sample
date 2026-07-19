# AWS Lambda MicroVMs のマネージドベースイメージARN調査

## 概要

`arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1` + `BaseImageVersion: "1"` の組み合わせが `InvalidRequest` になった件を調査した。ARNの命名パターン自体はAWS公式ドキュメント・スキル資料に繰り返し登場する記法と一致するが、`BaseImageVersion` に固定値 `"1"` を決め打ちできる根拠はドキュメント上どこにも存在しない。値を確定するには、後述のList系APIを実行して自環境・自リージョンの現在値を取得する必要がある。

## 1. マネージドベースイメージARNの形式

AWS公式ドキュメント（MicroVM images ガイド）およびAWS提供のLambda MicroVMsスキル資料（getting-started.md）は、いずれも同一の例示ARNを使用している。

- 形式: `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`
- ドキュメント中の具体例（リージョン部分は `us-east-1` で例示）: `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`

ARNにリージョンが埋め込まれる設計のため、リージョンごとに異なるARN文字列になる（`us-west-2` なら `arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1` になるという推測は形式としては妥当）。ただし、この末尾 `al2023-1` は「イメージ名」であり、`BaseImageVersion` パラメータとは別物である点に注意。ドキュメントはこの点を明示的に区別している。

## 2. `BaseImageVersion` の実値

公式ドキュメントは、ベースイメージのバージョンには `AVAILABLE`→`DEPRECATED`(60日)→`EXPIRING`(30日)→`EXPIRED`→`RECALLED` という寿命管理ライフサイクルがあり、各バージョンの状態はリージョン・時期によって変動すると明記している。具体的なバージョン文字列（`"1"` が有効か、日付形式か等）を固定値として記載した一次情報は見つからなかった。今回の`InvalidRequest`エラーは、`al2023-1` というイメージ名に対して `1` という`BaseImageVersion`が現時点のus-west-2に存在しない（すでに`EXPIRED`か、その番号体系自体が異なる）ことを示している可能性が高い。

**結論**: `BaseImageVersion="1"` を決め打ちで使うのは推奨できない。省略時はデフォルトで最新バージョンが自動適用されるため、まずは`BaseImageVersion`を省略し、`BaseImageArn`のみ指定してデプロイを試すのが最も安全な回避策である。

## 3. 有効な値を自己確認する方法

AWS CLI（`lambda-microvms`サービスのサブコマンド。`aws lambda list-microvm-images`ではなくサービス名`lambda-microvms`配下のコマンドである点が既存調査の見落とし）で列挙できる。

- `aws lambda-microvms list-managed-microvm-images --region us-west-2`: 利用可能なマネージドベースイメージの`imageArn`一覧（`createdAt`/`updatedAt`付き）を取得する。
- `aws lambda-microvms list-managed-microvm-image-versions --image-identifier <imageArn> --region us-west-2`: 取得した`imageArn`に対する有効な`imageVersion`一覧を取得する。

この2つのAPIが、まさに「マネージドベースイメージを自己列挙する」ための公式手段である。aws-cli 2.35.15で`aws lambda list-microvm-images`が見つからなかったのは、コマンドがLambda本体ではなく別サービスエンドポイント`lambda-microvms`（API名前空間 `Lambda-Microvms-2025-09-09`）に属するためと考えられる。手元のCLIバージョンでこのサブコマンド自体が存在しない場合は、CLIのアップデートが必要である。

## 推奨アクション

1. まず `BaseImageVersion` プロパティを削除し、`BaseImageArn: arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1` のみでデプロイを試す（デフォルトで最新版が使われる）。
2. 上記で解決しない場合は、`aws lambda-microvms list-managed-microvm-images --region us-west-2` と `list-managed-microvm-image-versions` を実行し、実際に存在する`imageArn`・`imageVersion`をCDKコードに反映する。
3. 将来のドリフト防止のため、CI等に上記List系APIの疎通確認を組み込み、ハードコードした`BaseImageArn`/`BaseImageVersion`が定期的にまだ有効か検証する仕組みを検討する。

## 参考リンク

- [MicroVM images (MicroVM base images / List系CLIコマンド例)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [ListManagedMicrovmImages - Lambda MicroVM API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListManagedMicrovmImages.html)
- [ListManagedMicrovmImageVersions - Lambda MicroVM API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListManagedMicrovmImageVersions.html)
- [AWS::Lambda::MicrovmImage - CloudFormation Template Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-microvmimage.html)
- [AWS introduces Lambda MicroVMs for isolated execution of user and AI-generated code (What's New)](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/)
