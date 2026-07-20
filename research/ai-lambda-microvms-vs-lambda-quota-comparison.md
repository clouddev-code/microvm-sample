# AWS Lambda MicroVMs vs 従来Lambda サイズ・リソース上限比較

> 対象: AWS Lambda MicroVMs（プレビュー、2026年6月発表、boto3サービス名`lambda-microvms`）と、
> 従来のAWS Lambda（通常の関数実行環境）とのサイズ制限・リソース上限の違いの裏取り調査。
> すべてAWS公式ドキュメント（Lambda Developer Guide）で確認済みの事実。

## 1. デプロイパッケージ/イメージサイズ

- **従来Lambda**: zipデプロイパッケージは解凍後250MB上限（APIアップロードは50MB圧縮）、コンテナイメージは10GB（非圧縮、全レイヤー込み）。
- **Lambda MicroVMs**: `Dockerfile`とアプリ成果物を含むzipをS3経由でアップロードし、Lambda管理ベースイメージ上でビルドしてFirecrackerスナップショットを生成する方式。**コード成果物zip自体のサイズ上限は公式ドキュメントに明記が見当たらず不明。**

参照: [MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)

## 2. メモリ上限

- **従来Lambda**: 128MB〜10,240MBの範囲、1MB刻み。
- **Lambda MicroVMs**: baseline/peakの垂直スケーリングモデルを採用。5段階のサイズがあり、baseline 0.5/1/2(デフォルト)/4/8GBに対し、peakはその4倍（各2/4/8/16/32GB）まで自動スケール。**最大peakメモリは32GB**。アカウント単位でRUNNING/SUSPENDED状態の全MicroVM合計メモリのクォータがあり、デフォルト400GB（バージニア北部・オレゴン・オハイオ・東京は1,024GB）、これも4倍までバースト可能。

参照: [MicroVM sizing](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html) / [Lambda quotas – MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas)

## 3. CPU/vCPU上限

- **従来Lambda**: メモリに比例配分（1,769MBで1vCPU相当、最大約6vCPU相当）。
- **Lambda MicroVMs**: メモリと連動（2GB=1vCPU）。baseline 0.25/0.5/1/2/4vCPUに対し、peakは4倍の1/2/4/8/**16vCPU**まで。**最大peak vCPUは16**。

参照: [MicroVM sizing](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)

## 4. 一時ストレージ（ディスク）上限

- **従来Lambda**: `/tmp`は512MB〜10,240MB（1MB刻み、設定可能）。
- **Lambda MicroVMs**: サイズ階層ごとにMax Disk Spaceが固定。baseline 0.5/1/2GB階層で8GB、4GB階層で16GB、8GB階層で**最大32GB**。

参照: [MicroVM sizing](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)

## 5. 実行時間の上限

- **従来Lambda**: 関数タイムアウト最大900秒（15分）、変更不可のハード上限。
- **Lambda MicroVMs**: `maximumDurationInSeconds`は1〜28,800秒（8時間）の範囲で指定可能。クォータ表でも「Maximum execution duration per MicroVM: 8時間（28,800秒）、Adjustable: No」と明記され、この8時間がハード上限であることを確認。`maxIdleDurationSeconds`（サスペンドまでの無通信時間）も最大28,800秒。

参照: [Lambda quotas – MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas) / [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)

## 6. リクエスト/レスポンスペイロードサイズ

- **従来Lambda**: 同期呼び出しはリクエスト・レスポンス各6MB、非同期は1MB（256KBではなく現行公式値は1MB）、ストリーミングレスポンスは200MB。
- **Lambda MicroVMs**: 固定のペイロードサイズ上限は設けられておらず、代わりにMicroVMサイズに比例した**帯域幅制限**が適用される。baseline 0.5GBで1MB/s、1GBで2MB/s、2GBで4MB/s、4GBで8MB/s、8GBで16MB/s（インバウンド・アウトバウンド共通）。

参照: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) / [Networking – Request/response bandwidth](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html#microvms-networking-bandwidth)

## 7. 同時実行数・スケーリング

- **従来Lambda**: アカウント/リージョン単位の同時実行数はデフォルト1,000（数万まで増枠可）、関数ごとのスケーリング速度は10秒あたり1,000実行環境。
- **Lambda MicroVMs**: 同時実行数という単位ではなく「全MicroVM合計メモリ」でクォータ管理（前述、デフォルト400GB/1,024GB）。加えてAPI別のレート制限があり、`RunMicrovm`5TPS、`ResumeMicrovm`5TPS、`SuspendMicrovm`2TPS、`TerminateMicrovm`10TPS、`GetMicrovm`100TPS、いずれも増枠可能。MicroVM単体の同時接続数もvCPU数依存（1vCPUで8接続、16vCPUで128接続）、秒間リクエスト数は4vCPU/8GBで40rps、16vCPU/32GBで160rps。

参照: [Lambda quotas – MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas)

## 8. その他の制限

- **環境変数**: 従来Lambdaは全変数合計4KB。MicroVMsはサイズ上限の記載はなく**変数数50個まで**という制約。
- **レイヤー**: 従来Lambdaは5層まで。MicroVMsはDockerfileベースのイメージビルド方式のため「レイヤー」概念自体が存在しない。
- **MicroVM固有の追加クォータ**: アカウント当たりのMicroVMイメージ数100（増枠可）、イメージあたりバージョン数50（増枠可）、同時イメージビルド数5（4リージョンでは10、増枠可）。`run-hook-payload`は最大16KB。

参照: [MicroVM images – Environment variables](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-env-vars) / [Lambda quotas – MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas)

## 比較まとめ表

| 項目 | 従来Lambda | Lambda MicroVMs |
|---|---|---|
| デプロイ成果物 | zip 250MB（解凍後）/ コンテナ 10GB | Dockerfileベースでビルド。成果物zip自体の上限は不明 |
| メモリ | 128MB〜10,240MB（1MB刻み） | baseline 0.5/1/2(既定)/4/8GB、peakは4倍まで自動スケールし最大32GB |
| vCPU | メモリ比例（最大約6vCPU相当） | メモリ連動（2GB=1vCPU）、baseline最大4vCPU、peak最大16vCPU |
| 一時ストレージ | 512MB〜10,240MB | サイズ階層で固定。8GB階層で最大32GB |
| 実行時間 | 最大900秒（15分、変更不可） | `maximumDurationInSeconds`最大28,800秒（8時間、増枠不可） |
| ペイロードサイズ | 同期6MB/非同期1MB/ストリーミング200MB | 固定上限なし、サイズ階層に応じた帯域幅制限（0.5GBで1MB/s〜8GBで16MB/s） |
| 同時実行 | アカウント同時実行数（既定1,000） | 全MicroVM合計メモリでクォータ管理（既定400GB、一部リージョン1,024GB）＋API別レート制限 |
| 環境変数 | 全変数合計4KB | サイズ上限記載なし、変数数50個まで |
| レイヤー | 5層まで | 概念自体が存在しない |

## 含意

Lambda MicroVMsは単発の関数実行を高速化する設計ではなく、「メモリ32GB・vCPU16・ディスク32GB・8時間稼働」まで許容する**常駐ワークロード向けの大型コンピュート**という性格が数値からも裏付けられる。従来Lambdaの15分・10GBという制約から完全に脱却する代わりに、同時実行数の考え方自体が「実行環境数」から「合計メモリ量」に変わっている点が運用設計上の重要な違い。

## 不明な点（まとめ）

- MicroVMイメージビルド用のコード成果物（zip）自体のサイズ上限
- MicroVMエンドポイント経由の1リクエストあたりの絶対的なペイロードサイズ上限（帯域幅制限のみ確認、サイズキャップの明記なし）

## 参考リンク

- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [MicroVM images（sizing/env vars）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Networking – bandwidth limits](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)

## 補足: idle-suspend / auto-resumeの再確認（`ai-lambda-microvms-suspend-resume-lifecycle.md`と重複するが本調査でも再確認）

- **Suspend**: 公開HTTPSエンドポイントへの着信トラフィックが`maxIdleDurationSeconds`内に途絶えると自動的にSuspendされる。判定基準はCPU使用率やプロセス活動ではなく、**MicroVMプロキシエンドポイントへの着信トラフィックの有無のみ**（`idlePolicy`省略時はこの機構自体が無効）。
- **Resume**: Suspend中に着信トラフィックがあった場合、**`autoResumeEnabled=true`のときのみ**自動的にResumeされる（リクエストを保持したまま`/resume`フック完了後に配送、レイテンシ増は最初のリクエストのみ）。`autoResumeEnabled=false`時に着信トラフィックがあった場合の挙動（即エラーかタイムアウトか）は公式ドキュメントに明記が無く、依然として不明点。
