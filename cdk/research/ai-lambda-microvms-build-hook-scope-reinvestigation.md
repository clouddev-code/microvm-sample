# AWS Lambda MicroVMs イメージビルド時のrun/suspend/resume/terminateフック疎通確認有無の再調査

## 調査結果サマリー

`microvms-images.html`、`microvms-how-it-works.html`、`CreateMicrovmImage` APIリファレンス、および`MicrovmImageHooks`/`MicrovmHooks`のCloudFormationリファレンスを確認した結果、**ビルド・検証(validate)プロセスの一環として`run`/`suspend`/`resume`/`terminate`フックを疎通確認(スモークテスト)するという記述は、いずれのページにも見つからなかった**。

### 1. ビルド系ページにrun/suspend/resume/terminateへの言及はあるか

`microvms-images.html`の「MicroVM image build hooks」節は、`/ready`と`/validate`のみを表形式で説明しており、他フックへの言及はない。`microvms-how-it-works.html`の「How Lambda builds your image」も、ビルド手順を次の5ステップで説明する。

1. Lambdaが指定されたベースイメージで新規MicroVMをプロビジョニングする。
2. `Dockerfile`の指示を実行する。
3. `ENTRYPOINT`または`CMD`でアプリケーションを起動する。
4. `/ready`フックが有効な場合、アプリケーションの準備完了(HTTP 200)を待つ。
5. ディスクとメモリ状態のスナップショットを取得する。

このステップ内にも`/run`等への言及はなく、むしろ同ページは「If your application generates unique content during the build ... generate unique content after the MicroVM starts using the `/run` lifecycle hook」と明記しており、`/run`はビルド後(MicroVM起動後)に呼ばれるものとして明確に区別している。

`CreateMicrovmImage`のレスポンス構造(`hooks.microvmHooks`と`hooks.microvmImageHooks`)は、設定値(ENABLED/DISABLED)をエコーバックするフィールドに過ぎず、ビルド中にそれらを実行したことを示す記述は存在しない。

### 2. MicrovmImageHooksとMicrovmHooksの説明文の違い

CloudFormationリファレンスの説明文は明確に分離されている。

- `MicrovmImageHooks`: "Configuration for hooks invoked during MicroVM image build events such as ready and validate."
- `MicrovmHooks`: "Configuration for lifecycle hooks invoked during MicroVM events such as run, resume, suspend, and terminate."

前者は「image build events」、後者は「MicroVM events」(実行時イベント)と明確に区別されており、`run`等がビルド時に呼ばれる・検証されるという記述は存在しない。ただし「ビルド時には一切検証しない」と明示的に否定する一文もなく、単に呼び出しタイミングの説明にとどまる。

### 3. stateReasonの列挙値

`ListMicrovmImageBuilds`(および同等の`GetMicrovmImageBuild`系)APIリファレンスでは、`stateReason`は`Type: string`、説明は"The reason for the build state, if applicable."のみで、**enumとしての列挙値一覧は公開ドキュメント上に存在しない**。`RUN_HOOK_FAILED`や`LIFECYCLE_HOOK_VALIDATION_FAILED`のような値についての記述は見つからなかった(前回確認された`S3_ACCESS_DENIED`等も、ドキュメントのenum定義ではなく実際のAPIレスポンス観測に基づくものと考えられる)。

## 結論

今回参照した公式ドキュメントの範囲では、ビルド・検証プロセスがrun/suspend/resume/terminateフックを疎通確認するという記述は見つからず、前回の結論(ビルドロール配下で呼ばれるのは`/ready`・`/validate`のみ)を覆す一次情報はなかった。観測されたSQS `AccessDenied`エラーの原因はドキュメントからは説明できないため、無理な推測は避け、AWSサポート等への確認を推奨する。

## 参考リンク

- [MicroVM images (MicroVM image build hooks)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [AWS Lambda MicroVMs core concepts (How Lambda builds your image)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [AWS::Lambda::MicrovmImage MicrovmImageHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmimagehooks.html)
- [AWS::Lambda::MicrovmImage MicrovmHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmhooks.html)
- [ListMicrovmImageBuilds (botocore reference)](https://docs.aws.amazon.com/botocore/latest/reference/services/lambda-microvms/paginator/ListMicrovmImageBuilds.html)
- [Security and permissions (IAM roles / lifecycle hook execution role)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
