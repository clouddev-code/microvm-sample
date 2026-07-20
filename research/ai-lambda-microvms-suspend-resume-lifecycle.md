# AWS Lambda MicroVMs（プレビュー）Suspend/Resume仕様の裏取り調査

> 対象API バージョン: `2025-09-09` / boto3サービス名: `lambda-microvms`
> 本ドキュメントは既存メモ（`ai-lambda-microvms-api.md`、`ai-lambda-microvm-sqs-worker-execution-role-idle-policy.md`）に記載された未確定点を、AWS公式ドキュメント（APIリファレンス、Developer Guide、公式Pricingページ）で裏取りした結果をまとめたもの。

## SuspendMicrovm APIの仕様

### 公式ドキュメントで確認できた事実

- エンドポイントは `POST /2025-09-09/microvms/{microvmIdentifier}/suspend`。URIパラメータは `microvmIdentifier`（必須、1〜256文字）のみで、リクエストボディは存在しない。
- 成功時は `HTTP 200` で空のHTTPボディが返却される。
- エラーは次の6種類。既存メモの4種に加えて `InternalServerException`（500、`retryAfterSeconds`を含む）と `ValidationException`（400）が正式に定義されている。
  - `AccessDeniedException`（403）
  - `ConflictException`（409、`resourceId`・`resourceType`を含む。現在のリソース状態と競合する場合に発生）
  - `InternalServerException`（500）
  - `ResourceNotFoundException`（404、`resourceId`・`resourceType`を含む）
  - `ThrottlingException`（429、`quotaCode`・`retryAfterSeconds`・`serviceCode`を含む）
  - `ValidationException`（400）
- API説明文に「Suspends a running MicroVM, preserving its full memory and disk state. The MicroVM transitions through SUSPENDING to SUSPENDED. To restore, call ResumeMicrovm or send traffic to the endpoint if autoResumeEnabled is true.」と明記されており、RUNNING状態からのみ呼び出せることが前提とされている（RUNNING以外での呼び出しは`ConflictException`になると解釈できる）。
- IAMアクションは `lambda:SuspendMicrovm`。boto3では `LambdaMicroVMs` クライアントの `suspend_microvm(microvmIdentifier=...)` メソッドで呼び出す。

参照: [API_SuspendMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_SuspendMicrovm.html) / [Security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)

### 不明な点

- `409 ConflictException` が発生する具体的な状態（SUSPENDING中、TERMINATING中など）の網羅的な一覧はAPIリファレンス上には明記がない。エラーメッセージ本文で個別に案内される可能性があるが、ドキュメント上は「現在のリソース状態との競合」としか記載がなく、不明。

## ResumeMicrovm APIの仕様

### 公式ドキュメントで確認できた事実

- エンドポイントは `POST /2025-09-09/microvms/{microvmIdentifier}/resume`。URIパラメータは `microvmIdentifier`（必須、1〜256文字）のみで、リクエストボディは存在しない。
- API説明文に「Resumes a suspended MicroVM, restoring it to RUNNING state with all state intact. The MicroVM must be in SUSPENDED state.」と明記されている。つまり **SUSPENDED状態からのみ呼び出せる**。
- 成功時は `HTTP 200` で空のHTTPボディが返却される。エラー種別はSuspendMicrovmと同一の6種類（AccessDeniedException, ConflictException, InternalServerException, ResourceNotFoundException, ThrottlingException, ValidationException）。
- IAMアクションは `lambda:ResumeMicrovm`。
- Developer Guide（Running and using MicroVMs）の「Resume behavior」節に以下の記載がある。
  - MicroVMが再開する際（APIコール経由・自動再開経由いずれも）、Lambdaはサスペンド時のチェックポイントからメモリとディスクの状態を復元する。
  - MicroVMは `/resume` フックが実行されている間は `SUSPENDED` 状態のままであり、フックが `HTTP 200` を返した後に `RUNNING` に遷移してトラフィックを受け付け始める。
- **明示的なResumeMicrovm呼び出しと自動再開（auto-resume）の違い**（「Auto-resume」節）:
  - `autoResumeEnabled=true` の場合、サスペンド中のMicroVMのエンドポイントにトラフィックが到達すると、Lambdaが自動的に `resume-microvm` 相当の処理を行う。
  - 自動再開の場合、Lambdaは到達したリクエストを保持（hold）したまま再開処理（`/resume`フックの実行を含む）を完了させ、その後にアプリケーションへリクエストを配送する。
  - 自動再開は最初のリクエストにのみレイテンシを追加する。復元される状態サイズと `/resume` フックの実行時間に依存する。再開が成功しない場合、呼び出し元には `502 Bad Gateway` が返る。
  - 一方、明示的な `ResumeMicrovm` API呼び出しは、着信トラフィックの有無に関わらず、任意のタイミングでMicroVMを能動的に `RUNNING` へ戻す手段である。

参照: [API_ResumeMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ResumeMicrovm.html) / [Running and using MicroVMs - Resume behavior / Auto-resume](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)

### 不明な点

- `autoResumeEnabled=false` かつ着信トラフィックがある場合に何が起きるか（リクエストが即座にエラーになるのか、タイムアウトになるのか）についての明記は見当たらない。不明。

## IdlePolicyの各フィールドと自動サスペンド無効化の方法

### 公式ドキュメントで確認できた事実

`IdlePolicy` オブジェクトの定義（APIリファレンス）:

- `autoResumeEnabled`（Boolean、Required: Yes）: サスペンド中にリクエストを受信した際、MicroVMを自動的に再開するかどうかを示す。
- `maxIdleDurationSeconds`（Integer、Required: Yes、最小値60）: MicroVMがアイドル状態のまま存在できる最大時間（秒）。この時間を超えると自動的にサスペンドされる。Developer Guideには上限値として **28,800秒（8時間）** の記載がある（APIリファレンス自体には上限の明記はない）。
- `suspendedDurationSeconds`（Integer、Required: Yes、最小値0）: MicroVMがサスペンド状態のまま存在できる最大時間（秒）。この時間を超えると自動的にTerminateされる。

これら3フィールドは、**`idlePolicy` オブジェクト自体を指定する場合はすべて必須**（Required: Yes）。

**idle判定基準について**: `IdlePolicy` APIリファレンスに「Idle time is measured by inbound traffic through the MicroVM proxy endpoint — if no requests arrive within the configured duration, the MicroVM is suspended.」と明記されている。Developer Guideの「Idle policy configuration」節にも同様に「The presence of traffic through the MicroVM's endpoint signals activity.」とあり、**CPU使用率やプロセスのアクティビティは一切考慮されず、MicroVMプロキシエンドポイントへの着信トラフィックの有無のみで判定される**ことが公式に確認できた。既存メモの記載は正しい。

**自動サスペンドを無効化する正式な方法**: `RunMicrovm` APIリファレンスにおいて `idlePolicy` はRequired: No（任意項目）であり、公式Agent Skill（`aws-lambda-microvms`）の参照情報に以下の明確な記載がある。

> The `idlePolicy` block itself is **optional** on `RunMicrovm` — omit it to disable idle-based auto-suspend entirely.

および

> For background workers, set high `maxIdleDurationSeconds` or disable auto-suspend by omitting `idlePolicy` in the request.

つまり、既存メモで「専用フラグの有無が未確定」とされていた点について、**専用の`disabled`フラグは存在しないが、`RunMicrovm`呼び出し時に`idlePolicy`パラメータ自体を省略することが、自動サスペンドを完全に無効化する正式な方法である**ことが確認できた。この場合、アイドル判定に基づく自動サスペンドは発生しない（明示的な`SuspendMicrovm`呼び出しは引き続き可能と考えられる）。

Developer Guideの「Idle policy configuration」節にも運用上の注意として次の記載がある。

> For asynchronous applications that do not actively send or receive traffic through the endpoint, disable automatic suspension or configure a suitable idle duration.

これはSQSロングポーリングワーカーのようなユースケースにまさに該当する記載であり、`idlePolicy`省略によるサスペンド無効化、または`maxIdleDurationSeconds`を最大化する運用のどちらも公式に推奨されるパターンであることが確認できた。

参照: [API_IdlePolicy](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html) / [API_RunMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html) / [Running and using MicroVMs - Idle policy configuration](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html) / AWS公式Agent Skill `aws-lambda-microvms`（`lifecycle-model.md`）

### 不明な点

- `idlePolicy` を省略した場合の内部的なデフォルト値（例えば内部的に「サスペンドしない」設定が入るのか、単に自動サスペンド機構自体がバインドされないのか）についての実装レベルの詳細はドキュメント上明記がない。
- `maxIdleDurationSeconds` の**上限値**がAPIリファレンス（`API_IdlePolicy.html`）自体には明記されておらず、Developer Guideの表にのみ「Maximum: 28,800 (8 hours)」という記載がある。両ドキュメント間で一次情報源としての優先度に差があるため、正式な仕様上限として扱うにはAPIリファレンス側での明記がない点に留意が必要。

## MicroVMライフサイクル状態とSuspend/Resumeの状態遷移

### 公式ドキュメントで確認できた事実

Developer Guide「AWS Lambda MicroVMs core concepts」に状態一覧・状態遷移表が明記されている。

状態（State）一覧:

- `PENDING`: MicroVMがプロビジョニング中。リソース割り当てとスナップショットのロードが行われている。
- `RUNNING`: MicroVMがアクティブで、エンドポイントURL経由でトラフィックを受け付けている。`/run`フックが完了した状態。
- `SUSPENDING`: MicroVMがサスペンド処理中。`/suspend`フックが実行中で、ディスクとメモリのチェックポイントが取得されている。
- `SUSPENDED`: MicroVMはサスペンド済み。状態は保持され、コンピュート課金は発生しない。ResumeまたはTerminateが可能。
- `TERMINATING`: MicroVMが終了処理中。`/terminate`フックが実行中で、リソースが解放されている。
- `TERMINATED`: MicroVMは終了済み（終端状態）。再開・再起動は不可能。

状態遷移表（トリガー明記）:

| 遷移元 | 遷移先 | トリガー |
|---|---|---|
| PENDING | RUNNING | プロビジョニング完了、`/run`フック成功 |
| RUNNING | SUSPENDING | アイドル時間超過、または明示的な`suspend-microvm`API呼び出し |
| SUSPENDING | SUSPENDED | `/suspend`フック完了、メモリ・ディスク状態のチェックポイント完了 |
| SUSPENDED | RUNNING | トラフィック到達（`autoResumeEnabled=true`の場合）、または明示的な`resume-microvm`API呼び出し |
| RUNNING | TERMINATING | 明示的な`terminate-microvm`API呼び出し、または`maximumDurationInSeconds`超過 |
| SUSPENDED | TERMINATING | `suspendedDurationSeconds`超過、または明示的な`terminate-microvm`API呼び出し、または`maximumDurationInSeconds`超過（実機確認済み、下記「実機検証」参照） |
| TERMINATING | TERMINATED | `/terminate`フック完了、全リソース解放 |

### 実機検証（2026-07-20）: SUSPENDED状態でも`maximumDurationInSeconds`超過で強制terminateされる

ドキュメントの状態遷移表では「SUSPENDED → TERMINATING」のトリガーとして`suspendedDurationSeconds`超過のみが明記されており、`maximumDurationInSeconds`がSUSPENDED状態にも適用されるかは表の記載からは読み取れなかった。これを実機で検証した。

検証条件（`SyncHelloWorldStack`のMicroVMイメージを使用）:
- `run-microvm`実行時刻（`startedAt`）: `2026-07-20T12:44:31.415+09:00`
- `idlePolicy`: `{"autoResumeEnabled":true,"maxIdleDurationSeconds":60,"suspendedDurationSeconds":28800}`（=8時間、意図的に上限値）
- `maximumDurationInSeconds`: `28800`（=8時間）
- 起動から約68秒後（12:45:39頃）に`SUSPENDED`へ遷移。以降、意図的に一切トラフィックを送らず放置（`get-microvm`によるポーリングはエンドポイントへのトラフィックに該当しないため自動再開の原因にはならない）。

結果:
```json
{
  "state": "TERMINATED",
  "startedAt": "2026-07-20T12:44:31.415000+09:00",
  "terminatedAt": "2026-07-20T20:44:33.984000+09:00",
  "stateReason": "MicroVM exceeded maximum lifetime."
}
```

`terminatedAt`は`startedAt`からほぼ正確に**8時間0分2.5秒後**であり、`stateReason`も明示的に
「MicroVM exceeded maximum lifetime.」となっている。これは`suspendedDurationSeconds`の起点
（SUSPENDED突入時刻、12:45:39頃）から8時間後（20:45:39頃）ではなく、`startedAt`（RunMicrovm
実行時刻）から8時間後の時刻と一致する。

**結論（実機確認済み）**: `maximumDurationInSeconds`はMicroVMの状態（RUNNING/SUSPENDED）に
関わらず、`startedAt`を起点とした絶対的な壁時計タイマーとして機能し、SUSPENDED状態であっても
容赦なく強制terminateする。SUSPENDED中はサスペンドによってタイマーが一時停止する、といった
救済措置は存在しない。長時間サスペンドさせておきたいユースケース（8時間近く着信が無いことが
想定されるワークロード等）では、`maximumDurationInSeconds`の上限（8時間）そのものが実質的な
生存期間の上限になる点に注意が必要。8時間を超えて使い続けたい場合は、`TERMINATED`前に
明示的に新しい`RunMicrovm`を呼び直す運用（新しいmicrovmId・エンドポイントが発行される）が
必須になる。

既存メモの「RUNNING → (idle) → SUSPENDING → SUSPENDED → (resume) → RUNNING、またはSUSPENDED → TERMINATED（`suspendedDurationSeconds`経過後）」という理解は、遷移の方向性としては**概ね正しい**。ただし正確には `SUSPENDED → TERMINATING → TERMINATED` という2段階の遷移であり、`SUSPENDED`から直接`TERMINATED`になるわけではない（`/terminate`フック実行のための`TERMINATING`状態を経由する）。

なお重要な注意書きとして、次の記載がある。

> If your `/run` hook fails or times out, the MicroVM may transition directly to `TERMINATING` without ever reaching `RUNNING`.

参照: [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)

### 不明な点

- 特になし。状態一覧・遷移表とも公式ドキュメントに明記されている。

## SuspendMicrovm呼び出し時にMicroVM内部で起きること

### 公式ドキュメントで確認できた事実

- **メモリ・ディスク状態は保持される**。`SuspendMicrovm`のAPI説明に「preserving its full memory and disk state」と明記。Developer Guideでも「Memory and disk state are preserved.」（SUSPENDED状態の説明）と重複して確認できる。
- **チェックポイント/スナップショットの仕組みがある**。SUSPENDING状態の説明に「Disk and memory are being checkpointed.」とあり、Firecracker VMのスナップショット機構を用いてメモリとディスクの状態がチェックポイントされることが確認できる（MicroVM imageのビルド時に使われるものと同種の、Firecrackerスナップショット技術がベースになっている）。
- **サスペンド前にライフサイクルフック`/suspend`が呼び出される**。Developer Guideの「Lifecycle hooks」節・「The /suspend hook」節に、Lambdaがサスペンド前に`/suspend`フック（`POST /aws/lambda-microvms/runtime/v1/suspend`）を呼び出すことが明記されている。用途は「保留中の書き込みをフラッシュし、ネットワーク接続を閉じ、サスペンド境界を越えて保持してはならないリソースを解放すること」。
- **実行中プロセスについて**: 「core concepts」ページのビルドプロセス説明で「Lambda captures a snapshot of the disk and memory state, including all running processes.」と記載されており、スナップショット（イメージビルド時）には実行中プロセスも含めて状態が保存される旨が明記されている。サスペンド時のチェックポイントについても同様に、ディスク・メモリの完全な状態が保持される（＝実行中プロセスの状態を含む）と解釈できる記載がある。
- **再開時のフック**: `/resume`フックは「Re-establish network connections, refresh credentials, validate state.」のために使われ、MicroVMは`/resume`フック実行中は`SUSPENDED`状態のままで、フックが`HTTP 200`を返した後に`RUNNING`へ遷移する。

参照: [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html) / [Running and using MicroVMs - Lifecycle hooks / Suspending and resuming MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)

### 不明な点

- 「実行中プロセスがサスペンド中にどのような状態（一時停止/凍結）で維持されるか」という、Firecracker VM自体の技術的な内部動作（例えばvCPU実行の一時停止タイミングと`/suspend`フックの実行順序の詳細な同期関係）についての踏み込んだ説明はDeveloper Guideには無い。「`/suspend`フックが完了 → チェックポイント取得」という順序は確認できるが、フック実行中のプロセス実行状態（フリーズしているか通常通り動作しているか）についての明記はない。

## サスペンド中・サスペンド解除後の課金への影響

### 公式ドキュメントで確認できた事実

AWS Lambda公式Pricingページ（Lambda MicroVMsタブ）に明確な記載がある。

- **課金は3つの軸**: コンピュート（ベースライン・ピーク使用量に基づく秒単位課金）、スナップショット操作・ストレージ、データ転送。
- **RUNNING中**: ベースラインのコンピュートリソースに対して課金される。ベースラインを超えるリソース消費（垂直スケーリング分）は、実際に消費した時間分のみ追加課金される（ピーク容量分を常に課金されるわけではない）。
- **SUSPENDED中（サスペンド中）はコンピュート課金が発生しない**。Pricingページに「During idle periods, you can suspend a running MicroVM for up to 8 hours, preserving its memory and disk state without paying compute charges.」と明記。Developer Guide「core concepts」ページのSUSPENDED状態の説明にも「No compute charges accrue.」と重複して記載されている。
- **サスペンド中はスナップショットストレージ課金が発生する**。「You are charged for snapshot storage, snapshot data read (on start or resume), and snapshot data written (on suspend).」と明記されており、以下の3種類のスナップショット関連課金がある。
  - スナップショットのストレージ課金（保存されている間、継続的に発生）
  - スナップショットデータの読み込み課金（起動時・再開時）
  - スナップショットデータの書き込み課金（サスペンド時）
- **Scaling and concurrencyページのコストモデル要約**（Developer Guide）にも整合する記載がある。
  - Running MicroVMs incur compute charges.
  - Suspended MicroVMs incur snapshot storage charges but not compute charges.
  - Terminated MicroVMs incur no charges.
- **TERMINATED後は課金なし**。「Terminated MicroVMs incur no charges.」
- **AWS Lambda FAQ**にも「When a MicroVM is suspended, its full memory and disk state is preserved for up to 8 hours and you are no longer charged for compute usage.」との記載があり、整合している。

参照: [AWS Lambda Pricing - Lambda MicroVMs（Compute / Snapshots / Data Transfer節）](https://aws.amazon.com/lambda/pricing/) / [Running and using MicroVMs - Scaling and concurrency](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html) / [AWS Lambda FAQs](https://aws.amazon.com/lambda/faqs/)

### 不明な点

- スナップショットの読み込み・書き込み課金の**具体的な単価**（$/GB等）は、今回参照したPricingページの本文中には数値が明記されていなかった（ページ内に価格表テーブルが別途存在する可能性があるが、テキスト抽出結果には単価の数値が含まれていなかった）。正確な単価が必要な場合は、`aws-pricing-mcp-server`を用いた別途の料金試算調査が必要。
- サスペンド解除（Resume）そのものに対する固定コスト・追加料金の有無について、Pricingページには「snapshot data read (on start or resume)」課金が発生するとの記載はあるが、Resume専用の追加料金体系があるかどうかの明確な区分は確認できなかった。

## 補足: SQSロングポーリングワーカー構成に関する重要な追加確認事項

ユーザーの背景課題（SQSロングポーリングワーカーに対してidle-suspend機構が機能しない）に直接関連する、既存メモにない重要な事実を確認できたため付記する。

- AWS公式のLambda MicroVMs Agent Skill（`aws-lambda-microvms`、AWS公式MCPサーバー経由で取得）に、「**No self-suspend from inside the MicroVM. Call `SuspendMicrovm` from outside (via the public API).**」と明記されている。すなわち、MicroVM内部のアプリケーションコードが自分自身を能動的にサスペンドさせるAPI呼び出し手段は存在せず、**外部（呼び出し元）から`SuspendMicrovm`を呼ぶ必要がある**。
- 同スキルの「Idle is measured by traffic through the proxy endpoint. If your app does outbound work but receives no inbound traffic, the platform will count it as idle. For background workers, set high `maxIdleDurationSeconds` or disable auto-suspend by omitting `idlePolicy` in the request.」という記載も、既存メモの課題認識（着信トラフィックが無いとidle-suspendが機能しない＝SQSワーカーのようなoutbound主体のワークロードは常にアイドル扱いされてしまう）を裏付けている。
- この事実から、SQSロングポーリングワーカー構成でMicroVMの自動サスペンドを制御したい場合、設計上は以下のいずれかのパターンが公式ドキュメントの記載と整合する。
  - `idlePolicy`を省略して自動サスペンドを無効化し、ワーカー側（またはオーケストレーター役の外部プロセス・別Lambda関数等）が明示的に`SuspendMicrovm`を呼び出す運用にする。
  - `maxIdleDurationSeconds`をワークロードの特性に応じて長めに設定しつつ、同様に外部から`SuspendMicrovm`を呼び出す。

参照: AWS公式Agent Skill `aws-lambda-microvms`（`SKILL.md`「Known constraints」節、`lifecycle-model.md`「MicroVM state machine」節）

## 参考リンク

- [SuspendMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_SuspendMicrovm.html)
- [ResumeMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ResumeMicrovm.html)
- [IdlePolicy APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html)
- [RunMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
- [Running and using MicroVMs（ライフサイクルフック、Suspend/Resume、Idle policy）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [AWS Lambda MicroVMs core concepts（状態一覧・状態遷移表）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [Security and permissions（IAMアクション一覧）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [AWS Lambda Pricing（MicroVMs課金モデル）](https://aws.amazon.com/lambda/pricing/)
- [AWS Lambda FAQs（Suspend/Resumeの概要）](https://aws.amazon.com/lambda/faqs/)
