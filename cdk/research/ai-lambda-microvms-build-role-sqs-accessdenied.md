# AWS Lambda MicroVMs ビルド中のSQS AccessDeniedの原因調査

## 概要

公式ドキュメントを確認した結果、`CreateMicrovmImage`(イメージビルド・検証プロセス)が呼び出すフックは`/ready`と`/validate`のみであり、`/run`・`/suspend`・`/resume`・`/terminate`はビルド中には一切呼び出されない。さらに、フックの実行ロールもフェーズごとに明確に分離されており、ビルド時フック(`/ready`・`/validate`)はビルドロールで、実行時フック(`/run`・`/resume`・`/suspend`・`/terminate`)は実行ロールでのみ実行されると明記されている。したがって、質問にある「ビルドロールで`sqs:ReceiveMessage`が呼ばれてAccessDeniedになる」という事象は、ドキュメントに記載された仕様どおりであれば発生し得ず、アプリケーション側の実装(コード起動順序やルーティング)に原因があると考えられる。

## 1. ビルド・検証プロセスが呼び出すフックの範囲

`microvms-how-it-works.html`の「How Lambda builds your image」には、ビルドプロセスの手順が次のように明記されている。

1. Lambdaが指定されたマネージドベースイメージから新規MicroVMをプロビジョニングする
2. `Dockerfile`の指示を実行する
3. `ENTRYPOINT`/`CMD`でアプリケーションを起動する
4. `/ready`フックが有効な場合、アプリケーションの準備完了(`HTTP 200`)を待機する
5. ディスクとメモリの状態(実行中の全プロセスを含む)のスナップショットを取得する

この5ステップの記述には`/run`・`/suspend`・`/resume`・`/terminate`への言及は一切ない。また`microvms-images.html`の「MicroVM image build hooks」セクションでも、ビルドフックとして表に掲載されているのは`/ready`と`/validate`のみであり、`/validate`は「ビルド完了後、作成されたイメージから起動したテスト用MicroVM上でアプリケーションが正しく再開できるかを確認する」ものと説明されている。つまり`/validate`実行のために内部的に一時MicroVMが起動される点は事実だが、そのテスト起動においても`/run`は呼ばれず、あくまで`/validate`エンドポイントへのPOSTのみが行われる、という書き方になっている。

一方`/run`・`/suspend`・`/resume`・`/terminate`は同ページの「MicroVM lifecycle」セクションで独立して説明されており、それぞれ`run-microvm`・`suspend-microvm`・`resume-microvm`・`terminate-microvm`という明示的なAPI呼び出しによってのみ遷移がトリガーされると記載されている。`CreateMicrovmImage`(image build)とこれらの実行系APIは別のセクション・別のライフサイクルとして完全に分離して記述されている。

## 2. ロール分離の明記

`microvms-security.html`(Security and permissions)には次の一文がある。

> Lifecycle hooks execute under the role associated with their phase. Build-time hooks (`/ready` and `/validate`) execute under the build role. Runtime hooks (`/run`, `/resume`, `/suspend`, and `/terminate`) execute under the execution role.

これは調査対象の4つの疑問のうち(1)(2)に対する最も直接的な根拠であり、「ビルド専用ロールが`/run`等の実行時フックのために引き受けられる」という前提そのものがドキュメント上は成立しないことを示している。

## 3. ビルド時と実行時を判別する手段の有無

上記のとおり、公式ドキュメントの仕様では`/run`等の実行時フックはビルド中に呼ばれない設計になっているため、「呼び出しがビルド検証か実際の実行かをアプリ側で判別する環境変数・専用ヘッダ・リクエストボディの目印」に関する記述はどこにも見当たらなかった。ドキュメント上、判別の必要自体が生じない前提で仕様が設計されているためと考えられる。`/run`フックのリクエストボディに含まれるのは`microvmId`と`run-microvm`実行時に指定した`runHookPayload`のみで、ビルド由来か実行由来かを示すフラグの記載はない。

## 4. AccessDenied回避に関する公式推奨パターンの有無

`iam-and-security`関連のガイドでは、ビルドロールと実行ロールは本番環境では別々のARNにすべきと明記されており、「ビルドロールはS3/ECR権限を必要とするが実行中のアプリケーションコードに晒したくない、実行ロールはDynamoDBやSecrets ManagerなどアプリケーションIP固有の権限を必要とするがビルドには不要」という理由が述べられている。つまり公式の推奨は「ビルドロールに実行時と同じ権限セットを付与する」ことの真逆であり、ロールを共通化・拡大する設計は推奨されていない。また、「`/validate`フック内で意図的に実際のAWS API呼び出しを試みて権限の有無を確認させる」という設計思想についての言及も見当たらなかった。トラブルシューティングガイドにおいても、ビルド失敗の`stateReason`一覧(`S3_ACCESS_DENIED`等)はS3アクセス関連のみが列挙されており、SQS等の任意のAWS APIをビルド中に呼び出すこと自体が想定された使い方ではないと読み取れる。

## 結論と推奨アクション

ドキュメントの記述を素直に読む限り、今回のAccessDeniedは「AWSプラットフォームがビルドロールで`/run`相当の処理を呼んだ」ことによるものではなく、アプリケーションコード側で何らかの理由により、ビルド中(ビルドロールが有効な間)に`sqs.receive_message`が呼ばれてしまっていると考えるのが妥当である。特に、ビルドプロセスは`ENTRYPOINT`/`CMD`でアプリケーションを起動してから`/ready`を待ち受ける、という順序になっているため、HTTPハンドラの外側(モジュールインポート時の処理、フレームワークのstartupイベント、ワーカープロセス起動スクリプトなど)にSQSポーリングを開始するコードが紛れ込んでいないかを確認することを推奨する。この推測はドキュメントの直接的な裏付けがあるものではなく、ドキュメントから导かれる消去法的な推論である点に留意されたい。

## 参考リンク

- [AWS Lambda MicroVMs core concepts (How Lambda builds your image / MicroVM lifecycle)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [MicroVM images (MicroVM image build hooks)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Security and permissions (IAM roles / Lifecycle hooks execute under the role associated with their phase)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [AWS::Lambda::MicrovmImage MicrovmImageHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmimagehooks.html)
- [AWS::Lambda::MicrovmImage Hooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-hooks.html)
- [Working with snapshots (build phaseとuniqueness/接続再確立)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html)
