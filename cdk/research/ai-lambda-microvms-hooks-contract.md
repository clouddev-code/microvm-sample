# AWS Lambda MicroVMs の Hooks HTTPコンタクトとCPUアーキテクチャ調査

## 概要

`AWS::Lambda::MicrovmImage` の `Hooks` プロパティは、フックの呼び出しパス自体を指定するものではない。`HookState`（`ENABLED`/`DISABLED`）は、AWSが固定パスに対してPOSTリクエストを送信するかどうかのオン/オフスイッチであり、パス文字列を渡す用途ではない。CDK側の実装と、Flask/FastAPIワーカー側のルーティングは、この固定パス規約に合わせて修正する必要がある。

## 1. 各フックの実際のHTTPパスとメソッド

パスはAWSが固定的に規定しており、`HookState` の値やその他の設定で変更することはできない。イメージビルド時フックとインスタンスライフサイクルフックは、いずれも `POST` メソッドで、サービス側からワーカーの `Hooks.Port` に対して呼び出される。

イメージビルド時フック（`MicrovmImageHooks`）は以下のパスで呼び出される。

- `/ready`（内部的には `/aws/lambda-microvms/runtime/v1/ready`）: `Dockerfile` の `ENTRYPOINT`/`CMD` 起動後、アプリケーションの初期化完了をポーリングする。`HTTP 200` でスナップショット取得へ進み、`HTTP 503` の場合は `ReadyTimeoutInSeconds` まで再試行する。
- `/validate`（`/aws/lambda-microvms/runtime/v1/validate`）: イメージビルド完了後、作成されたイメージから起動した新しいMicroVM上でアプリケーションの正常動作を確認する。`HTTP 200` で成功、`HTTP 503` で `ValidateTimeoutInSeconds` まで再試行する。このフック中に処理したペイロードのアクセス領域は、実行時のスナップショット取得を最適化するために利用される。

インスタンスライフサイクルフック（`MicrovmHooks`）は以下のパスで呼び出される。

- `/run`（`/aws/lambda-microvms/runtime/v1/run`）: スナップショットからMicroVM起動後に呼ばれる。テナント固有状態の初期化やヘルスチェックに使用し、このフックが `HTTP 200` を返すまで外部トラフィックはMicroVMへ転送されない。リクエストボディには `microvmId` と、`run-microvm` 実行時に指定した `runHookPayload` がJSONで渡される。
- `/resume`（`/aws/lambda-microvms/runtime/v1/resume`）: `SUSPENDED` 状態から復帰した際に呼ばれる。ネットワーク再接続や認証情報の更新に使用し、このフックが完了するまでMicroVMは `SUSPENDED` のまま、完了後に `RUNNING` へ遷移する。
- `/suspend`（`/aws/lambda-microvms/runtime/v1/suspend`）: MicroVMをサスペンドする直前に呼ばれる。未書き込みデータのフラッシュや接続のクローズに使用する。
- `/terminate`（`/aws/lambda-microvms/runtime/v1/terminate`）: MicroVMを終了する直前に呼ばれる。データのフラッシュや外部システムへの通知、リソースのクリーンアップに使用する。

各フックの正式なコンタクトは、AWSが公開しているOpenAPI仕様（`Lambda MicroVMs Application Hook Interface`, version `2025-12-03`）に定義されている。`/run`のみリクエストボディのスキーマ（`RunRequestContent`: `microvmId`, `runHookPayload`）が明示されており、他のフックはリクエストボディなし・`200`（および `/ready`/`/validate` は `503`）のレスポンスのみを期待する。

## 2. `ENABLED`/`DISABLED` の意味

`HookState` は「AWSが該当ライフサイクルポイントでそのフックへPOSTリクエストを送るかどうか」を制御するスイッチであり、パスの有効化/無効化ではなく呼び出し自体の有効化/無効化を意味する。

- `ENABLED`: AWSが対応する固定パス（例: `/run`）に対してPOSTリクエストを送信し、対応する `*TimeoutInSeconds`（例: `RunTimeoutInSeconds`、範囲は1〜60秒）以内にレスポンスが返るのを待つ。タイムアウトすると失敗として扱われる（`/ready`・`/validate` はタイムアウトまで `503` で再試行を許容し、範囲は1〜3600秒）。
- `DISABLED`: AWSはそのフックの呼び出しを一切行わず、当該ライフサイクルステップを成功したものとして次に進む。ワーカー側にそのパスの実装が存在しなくても問題は起きない。

ポート番号（`Hooks.Port`）はフックを1つでも `ENABLED` にする場合は必須であり、すべてのフックはこの単一ポートで待ち受ける。

## 3. `CpuConfigurations[].Architecture` のサポート値

CloudFormationリソースリファレンス（`AWS::Lambda::MicrovmImage CpuConfiguration`）およびLambda MicroVM APIリファレンス（`API_CpuConfiguration`）のいずれも、`Architecture` の許容値は `ARM_64` のみと明記しており、リージョンごとの差異は記載されていない。したがって us-west-2 で確認された制限はアカウント固有・プレビュー限定のものではなく、現時点（2026年7月時点）でのサービス全体の仕様と判断できる。

Lambda MicroVMsは現在 US East (N. Virginia)、US East (Ohio)、US West (Oregon)、Asia Pacific (Tokyo)、Europe (Ireland) の5リージョンで利用可能であり、ドキュメント上はいずれのリージョンでも `x86_64` はサポート対象として言及されていない。将来的に `x86_64` が追加される可能性はあるが、現時点の公式ドキュメントに基づく限り、ARM_64のみが正としてよい。

## 参考リンク

- [Running and using MicroVMs (Lifecycle hooks / OpenAPI仕様)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [MicroVM images (MicroVM image build hooks)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [AWS::Lambda::MicrovmImage MicrovmHooks](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-microvmhooks.html)
- [AWS::Lambda::MicrovmImage CpuConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-microvmimage-cpuconfiguration.html)
- [API_CpuConfiguration - Lambda MicroVM API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CpuConfiguration.html)
- [AWS introduces Lambda MicroVMs for isolated execution of user and AI-generated code (What's New)](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/)
