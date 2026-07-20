# AWS Lambda MicroVMs TERMINATED後のエンドポイント挙動調査

> 対象: AWS Lambda MicroVMs（プレビュー、2026年6月発表、boto3サービス名`lambda-microvms`、APIバージョン`2025-09-09`）。
> MicroVMがTERMINATED状態に至った後、そのMicroVMのエンドポイントURLに着信リクエストがあった場合の挙動を、AWS公式Developer Guide・API Reference・AWS Labs公開のAgent Skill（`aws-lambda-microvms`）で裏取りした。

## 調査結果の要点

結論から述べると、**TERMINATED状態からの自動的な再起動（新規MicroVM作成やリクエストのルーティング）は行われない**。これはAgent Skillの`troubleshooting.md`に明記された「auto-resumeはTERMINATED状態のMicroVMを復活させない」という一文で裏付けられる一方、TERMINATED状態のエンドポイントへ着信した際に**具体的にどのHTTPステータスコードが返るか**は、公式ドキュメントの「MicroVMエンドポイントが返すエラーレスポンス一覧」に該当エントリがなく、明記されていない。

## 公式ドキュメントで確認できた事実

### 1. TERMINATEDへの2つの遷移経路は同一の終端状態に収束する

Developer Guide「AWS Lambda MicroVMs core concepts」の状態遷移表には、TERMINATINGへの遷移トリガーが2系統定義されている。

- `RUNNING → TERMINATING`: 「Explicit terminate-microvm API call, or maximumDurationInSeconds exceeded.」（明示的な`terminate-microvm`呼び出し、または`maximumDurationInSeconds`超過）
- `SUSPENDED → TERMINATING`: 「suspendedDurationSeconds exceeded, or explicit terminate-microvm API call.」（`suspendedDurationSeconds`超過、または明示的な`terminate-microvm`呼び出し）
- いずれの経路も`TERMINATING → TERMINATED`（「/terminate hook completed, all resources released.」）という同一の遷移で終端状態に到達する。

この表以外に、2つの経路（idle-suspend経由のterminateと、稼働上限到達によるterminate）でその後の挙動（エンドポイントの扱いなど）に差を設ける記載は、Developer Guide・API Reference・Agent Skillのいずれにも見当たらなかった。**両者は区別なく同一のTERMINATED終端状態として扱われる、というのが確認できた事実である。**

### 2. TERMINATEDは終端状態であり、再開・再起動は不可能

同ページの状態一覧表に明記されている。

> TERMINATED | MicroVM has been terminated. This is a terminal state. The MicroVM cannot be resumed or restarted.

### 3. auto-resumeはTERMINATED状態のMicroVMを復活させない（明示的な自動再起動の否定）

AWS Labs公開のAgent Skill（`agent-plugins`リポジトリ、`aws-lambda-microvms`スキル）の`references/troubleshooting.md`「Auto-resume not working」セクションに、以下の記載がある。

> Confirm the MicroVM's `state` is `SUSPENDED` (not `TERMINATED` — auto-resume doesn't revive terminated VMs).

これは`autoResumeEnabled=true`によるトラフィック契機の自動復旧メカニズムが、SUSPENDED状態専用の挙動であり、TERMINATED状態には適用されないことを明示している。Developer Guideの状態遷移表（`SUSPENDED → RUNNING`は「Traffic arrives (autoResumeEnabled=true) or explicit resume-microvm API call」とあり、対象はSUSPENDEDのみ）とも整合する。

**したがって、TERMINATED状態のMicroVMのエンドポイントへ着信リクエストがあっても、AWS側が自動的に新しいMicroVM（PENDING→RUNNING）を起動してリクエストをルーティングする仕組みは存在しないことが確認できた。** 新しいMicroVMを起動するには、呼び出し元が明示的に`RunMicrovm`を再度呼ぶ必要がある。

### 4. MicroVMエンドポイントが返す公式エラーコード一覧にTERMINATED専用のコードは存在しない

Developer Guide「Networking」ページの「Error responses」セクションには、「MicroVMエンドポイントがリクエストを処理・配送できない場合に返すHTTPステータスコード」として以下の5種類が網羅的に列挙されている。

| コード | ステータス | 原因 |
|---|---|---|
| 400 | Bad Request | 不正なリクエスト、無効なポートヘッダー/WebSocketサブプロトコル |
| 403 | Forbidden | トークンの欠落・期限切れ・無効、または許可されていないポートへのアクセス |
| 429 | Too Many Requests | レート制限超過 |
| 500 | Internal Server Error | 内部エラー |
| 502 | Bad Gateway | アプリケーションが応答しない、またはauto-resumeが最大リトライ回数以内に成功しなかった |

このリストに「MicroVMがTERMINATED状態のときにエンドポイントへアクセスした場合」という項目は存在しない。502の説明はauto-resume（＝SUSPENDED状態からの復旧）の失敗について述べたものであり、TERMINATED状態への言及ではない。**公式ドキュメント上、TERMINATED状態のエンドポイントへのリクエストに対して返される具体的なHTTPステータスコードは明記されていない。**

### 5. エンドポイントURLはMicroVMごとに`run-microvm`呼び出し時に新規発行される

Developer Guide「Networking」「Running and using MicroVMs」の両方に、以下の記載がある。

> Each Lambda MicroVM is reachable at a unique HTTPS endpoint URL, assigned when you call `run-microvm`.

> Each MicroVM has its own dedicated endpoint. There is no load-balancing across MicroVMs from a single endpoint – each endpoint is linked to a single MicroVM.

エンドポイントは個々の`microvmId`に1対1で紐づいた資源であり、`run-microvm`を呼ぶたびに新しい`microvmId`と新しいエンドポイントが発行される設計であることが確認できる。この設計から、TERMINATED後に処理を継続したい場合は、同じエンドポイントが再利用されるのではなく、**新規`RunMicrovm`呼び出しによって別のMicroVM・別のエンドポイントが生成される**という帰結が導かれる（ただし「旧エンドポイントURLが即座に失効するのか、無応答のまま残り続けるのか」という点自体を直接述べた記載は見つからなかった）。

### 6. `GetMicrovm`はTERMINATED後も引き続き利用可能

`GetMicrovm` APIレスポンスには`state`（`TERMINATED`を含む）・`terminatedAt`・`stateReason`フィールドがあり、Agent Skillの`troubleshooting.md`にも「Check the `terminationMessage` field in the `get-microvm` response for terminated MicroVMs.」という記載がある。すなわち、MicroVMのメタデータ自体はTERMINATED後もAPI経由で参照可能である。ただし、これはコントロールプレーンAPI（`GetMicrovm`）の話であり、データプレーンのエンドポイント（HTTPSプロキシ）が同様にTERMINATED後も応答し続けるかどうかとは別問題であり、後者についての明記はない。

## 不明な点（公式ドキュメントに明記なし）

- TERMINATED状態のエンドポイントへ着信リクエストがあった場合に返される**具体的なHTTPステータスコード**（即時エラー応答なのか、コネクション自体が確立できないのか、タイムアウトになるのか）。
- エンドポイントURL自体が**DNS解決レベルで失効するか、それとも到達可能だがプロキシ層でエラーを返すのか**。
- `maximumDurationInSeconds`超過による強制TERMINATEと、`suspendedDurationSeconds`超過によるTERMINATEとで、**その後のエンドポイント挙動に差異があるか**（状態遷移表上は完全に同一のTERMINATED終端状態に収束するとしか読み取れず、挙動の違いを示す記載は一切なかった）。
- ウェブ検索では「404 Not FoundまたはGoneが返るのではないか」という推測を述べる二次情報が一部見られたが、これはAWS公式ドキュメントに基づく記載ではなく、根拠のない推測であるため本調査では採用しない。

## 参考リンク

- [AWS Lambda MicroVMs core concepts（状態遷移表）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [Running and using MicroVMs（auto-resume、terminate-microvm）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Networking（エンドポイントのエラーレスポンス一覧）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Troubleshooting（terminationMessageフィールド）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html)
- [GetMicrovm API Reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html)
- [aws-lambda-microvms Agent Skill: lifecycle-model.md](https://github.com/awslabs/agent-plugins/blob/main/plugins/aws-serverless/skills/aws-lambda-microvms/references/lifecycle-model.md)
- [aws-lambda-microvms Agent Skill: troubleshooting.md（auto-resume doesn't revive terminated VMs）](https://github.com/awslabs/agent-plugins/blob/main/plugins/aws-serverless/skills/aws-lambda-microvms/references/troubleshooting.md)
- [Lambda quotas – MicroVMs（API別レート制限）](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas)
