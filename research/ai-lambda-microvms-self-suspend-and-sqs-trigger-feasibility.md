# AWS Lambda MicroVMs 自己サスペンドとSQSトリガー起動パターンの実現可能性調査

> 対象API バージョン: `2025-09-09` / boto3サービス名: `lambda-microvms`
> 本調査は、S3→常駐MicroVMワーカー（SQSロングポーリング）→Bedrock→DynamoDBという構成を前提に、「ワーカー自身によるSuspendMicrovm自己呼び出し」と「SQSトリガーによるMicroVM起動」の2点を公式ドキュメント・AWS公式Agent Skill（`aws-lambda-microvms`）で裏取りしたもの。

## ワーカー自身がSuspendMicrovmを自己呼び出しすることの可否

### 公式ドキュメントで確認できた事実

- AWS公式Agent Skill（`aws-lambda-microvms`）の「Known constraints」節に次の記載がある。

  > **No self-suspend from inside the MicroVM.** Call `SuspendMicrovm` from outside (via the public API).

  この文の直前・直後の他の制約（「Suspend → resume can't switch network connectors」「Auth token max TTL is 60 min」等）はいずれも技術的な仕様上の制約であり、同じ並びに記載されていることから、本項目も運用ガイダンスというより仕様として扱われている。ただし文言自体は「サポートしていない（unsupported）」ではなく「外部から呼べ」という指示であり、API呼び出しそのものを技術的にブロックする機構（IAMやネットワークレベルの拒否）についての記載は無い。
- IAM面: `lambda:SuspendMicrovm`は`executionRoleArn`にアタッチされたIAMポリシーで許可されていれば呼び出し可能というだけで、呼び出し元が「MicroVM内部かどうか」を区別してアクセスを拒否する仕組みはIAMポリシー言語・APIリファレンスのいずれにも記載がない（`aws:SourceVpc`等の条件キーを使った拒否ルールをユーザー自身が設定しない限り、内部からの呼び出しを区別する標準的な仕組みは存在しない）。
- ネットワーク面: `RunMicrovm`のデフォルトのegress network connectorは`INTERNET_EGRESS`であり、MicroVMはデフォルトでパブリックインターネットへ到達できる（[Networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.md)）。`lambda-microvms.<region>.amazonaws.com`のようなAWS公開APIエンドポイントへの到達を明示的に禁止する記載は無い。
- 認証情報面: 実行ロールの一時認証情報は、MicroVMのゲストOS内からIMDSv2エンドポイント`http://169.254.169.254/latest/meta-data/iam/security-credentials/execution_role`経由で取得可能であり、「Most AWS SDKs pick this up automatically via the default credential chain.」と明記されている（`references/iam-and-security.md`）。すなわちboto3等のSDKはMicroVM内部でも標準の認証情報チェーンでexecution roleの権限を使用できる。
- `microvmId`の入手経路: `/run`フックのリクエストボディに`microvmId`が自動的に含まれることがAPIリファレンス（OpenAPI仕様）およびAgent Skillの両方で明記されている。
- 以上を総合すると、**「MicroVM内部のアプリケーションコードが自身のexecutionRoleArnの権限とegress経路を使い、自分自身のmicrovmIdに対してSuspendMicrovmを呼び出す」という操作を、IAM・ネットワークの両面で技術的に妨げる記載は公式ドキュメント上見当たらない**。つまりAPI呼び出し自体は技術的に可能と解釈できる。
- ただし、Agent Skillが明確に「No self-suspend from inside the MicroVM」と述べている以上、**この操作は公式にはサポートされたパターンではなく、非推奨（少なくとも文書化された正規の手段ではない）**という位置付けである。

参照:
- AWS公式Agent Skill `aws-lambda-microvms`（`SKILL.md`「Known constraints」節）
- [Networking（egress network connectors、デフォルトのINTERNET_EGRESS）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [IAM and security（execution role、IMDSv2経由の認証情報取得）](AWS公式Agent Skill `aws-lambda-microvms` `references/iam-and-security.md`)
- [Running and using MicroVMs（`/run`フックのmicrovmId自動注入）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)

### 「No self-suspend from inside the MicroVM」の意味の明確化

- ドキュメント文言は「Call `SuspendMicrovm` from outside (via the public API).」であり、これは「専用の自己サスペンド用ショートカットAPI・システムコール（例えば`/suspend-self`のような特別なローカルエンドポイントや、ゲスト内カーネル機構）は提供されていない」ことを述べていると解釈できる。
- 一方で、「MicroVM内部から`lambda-microvms`の公開APIエンドポイント自体を（自分に対してであっても）呼び出すこと自体が技術的に不可能」という意味だと明記した記載は存在しない。前段で確認した通り、egressはデフォルトでインターネットに到達可能であり、IAM認証情報もIMDSv2経由で入手可能である。
- したがって最も妥当な解釈は、「**専用の自己サスペンド機構は用意されていない（＝『内側から自分を止めるボタン』は無い）が、公開APIとしての`SuspendMicrovm`をMicroVM内部から自分自身のIDを対象に呼び出す行為自体を技術的にブロックする実装は確認できない**」というものである。ただしこれは公式に明記されたサポートパターンではなく、AWSが将来的にこの経路を制限する可能性を否定する記載も無い。

### 不明な点

- 「No self-suspend from inside the MicroVM」が、実際にネットワークレベル・APIレベルでの拒否（例えばMicroVMの送信元IPやVPCエンドポイント経由のリクエストを`SuspendMicrovm`側で意図的に弾く実装）を意味するのか、単なる設計ガイドライン（推奨されないアンチパターン）に過ぎないのかは、公式ドキュメント上で断定できない。実装レベルの検証（実際にMicroVM内部から`boto3.client("lambda-microvms").suspend_microvm(...)`を自分自身のIDに対して呼び出すテスト）を行わない限り、確実な結論は得られない。
- 自己サスペンドを試みた場合に`AccessDeniedException`等が返るように意図的にブロックされているかどうかは、APIリファレンスのエラー一覧（`AccessDeniedException`, `ConflictException`, `InternalServerException`, `ResourceNotFoundException`, `ThrottlingException`, `ValidationException`）にも「呼び出し元がMicroVM自身の場合」という条件分岐の記載が無く、不明。

### SuspendMicrovm呼び出しとレスポンス受信のタイミング関係

- Developer Guide「Suspending and resuming MicroVMs」節に状態遷移が明記されている。`SuspendMicrovm`（または自動サスペンド）が呼ばれると、まず`RUNNING → SUSPENDING`に遷移し、この間に`/suspend`フックが実行される。フックが`HTTP 200`を返した後、メモリ・ディスクのチェックポイントが取得されて`SUSPENDED`に遷移する。
- `SuspendMicrovm` API自体の応答は「成功時はHTTP 200・空ボディ」であり、これは**API呼び出しの受理（サスペンド処理の開始）**を意味するものであって、サスペンド完了（`SUSPENDED`到達）を待つものではない（非同期的に処理が進む設計）。
- 呼び出し元がMicroVM内部のプロセスである場合、`SuspendMicrovm`のHTTPレスポンス自体は、そのプロセスがまだ`RUNNING`状態（`/suspend`フック実行前）で受け取れる可能性が高いと解釈できる。ただし「レスポンスを受け取ってから`/suspend`フックが呼ばれるまでの猶予時間」や「レスポンス受信とフック呼び出しの間の同期・非同期の詳細」についての明記は無い。
- 呼び出し元が外部プロセスであっても内部プロセスであっても、上記の状態遷移の順序自体（API呼び出し受理→`SUSPENDING`→`/suspend`フック→チェックポイント→`SUSPENDED`）は同一であるとドキュメント上解釈できる。「呼び出し元自身が凍結されるタイミング」については、`/suspend`フックの実行中は（フックがアプリケーション自身の一部として動作するため）通常のプロセス実行が継続していると解釈できるが、hookが200を返した後にVM全体がスナップショット目的で一時停止されるかどうかの厳密なタイミングは明記が無い。

### 不明な点

- `SuspendMicrovm` APIレスポンス（HTTP 200）を送信するタイミングと、実際に`SUSPENDING`状態への遷移が開始されるタイミングの前後関係（レスポンスを返してから遷移するのか、遷移を開始しつつ並行してレスポンスを返すのか）についての明記は無い。
- Firecracker VM自体のvCPU実行が実際に一時停止される正確なタイミング（`/suspend`フックの実行完了後か、チェックポイント取得中か）についての踏み込んだ説明は無い（既存調査`ai-lambda-microvms-suspend-resume-lifecycle.md`でも同様に不明と結論済み）。

## ヘルスチェック専用フックの有無

### 公式ドキュメントで確認できた事実

- Developer Guide「Lifecycle hooks」節およびAgent Skill `references/lifecycle-model.md`のいずれにも、ライフサイクルフックとして定義されているのは以下の6種類のみである。
  - ビルド時: `/ready`、`/validate`
  - ランタイム: `/run`、`/resume`、`/suspend`、`/terminate`
- `/run`フックの説明文には「Initialize per-tenant state, reset unique values, **perform health checks**.」という記載があるが、これは`/run`フック自体の用途の一つとして「ヘルスチェックを行うこと」が言及されているだけであり、`/run`とは別に独立した「定期ヘルスチェック用フック」ではない。
- 上記6フック以外に、周期的に（インターバルで）呼び出される専用のヘルスチェックフックはAPIリファレンス・Developer Guide・Agent Skillのいずれにも記載が無い。

### 結論

**「`/run`, `/suspend`, `/resume`, `/terminate`, ビルド時の`/ready`・`/validate`以外に、周期的なヘルスチェック目的のフックは存在しない」ことが公式ドキュメント上明記されている（正確には、6種類以外のフックへの言及が一切無いことをもって「存在しない」と判断できる）。**

参照: [Running and using MicroVMs - Lifecycle hooks](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html) / AWS公式Agent Skill `aws-lambda-microvms`（`references/lifecycle-model.md`）

## SQSトリガーでMicroVMを起動する設計パターンの整合性

### 公式ドキュメントで確認できた事実

- Agent Skill `SKILL.md`の「Choose AWS Lambda (functions) when」節に「Event-source integrations (S3, SQS, EventBridge, etc.) drive the function.」と明記されており、イベントソース連携（SQS含む）は通常のLambda関数が担うべきであるという明確なガイダンスがある。逆に言えば、MicroVMs自体をSQSイベントソースマッピングの直接ターゲットにするという設計は想定されていない（既存調査`ai-lambda-microvms-s3-trigger.md`のS3の場合と同様の構造）。
- **「SQS→仲介Lambda関数→GetMicrovmで状態確認→TERMINATED/存在しない場合はRunMicrovm、SUSPENDEDの場合はResumeMicrovm」という設計パターンそのもの**については、Agent Skill・Developer Guideのいずれにも、この具体的な分岐ロジックを名指しで推奨・言及する記載は無い。ただし、以下の個別要素はいずれも公式ドキュメント・APIリファレンスに整合する。
  - `GetMicrovm`は同期の参照系APIであり、`state`フィールド（`PENDING`/`RUNNING`/`SUSPENDING`/`SUSPENDED`/`TERMINATING`/`TERMINATED`）を返す（[API_GetMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html)）。
  - `RunMicrovm`は新規MicroVMを起動するAPIであり、既存の`TERMINATED`状態のMicroVMに対して再度使うことはできない（新規`microvmId`が発行される。既存メモ`ai-lambda-microvms-api.md`で確認済み）。
  - `ResumeMicrovm`のAPI説明文には「The MicroVM must be in SUSPENDED state.」と明記されており、`SUSPENDED`以外の状態から呼び出すと`ConflictException`になると解釈できる（既存調査`ai-lambda-microvms-suspend-resume-lifecycle.md`で確認済み）。
  - よって「状態に応じてRunMicrovmかResumeMicrovmを使い分ける」というロジック自体は、各APIの状態遷移の仕様と矛盾しない、整合的な設計である。ただし、この分岐ロジックをベストプラクティスとして名指しで推奨する一次情報は見当たらない。
- **並行呼び出しの競合（race condition）への対処**について、`ConflictException`の定義（「現在のリソース状態と競合する場合に発生（409、`resourceId`・`resourceType`を含む）」）はAPIリファレンスに明記されているが、これを「握りつぶして無視してよい」「Lambdaの同時実行数を1に制限すべき」といった具体的な推奨対処法は、Agent Skill・Developer Guideのいずれにも記載が無い。
  - なお、SQSのイベントソースマッピングと通常のLambda関数の同時実行数制御一般については、AWS公式ドキュメント（[Configuring reserved concurrency for a function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)）に、予約済み同時実行数（Reserved concurrency）を使って関数の並列実行数の上限・下限を制御できる旨の一般的な説明がある。ただし、これは通常のLambda関数一般の機能説明であり、MicroVMs起動の競合防止策として名指しで言及されたものではない。
- **`ResumeMicrovm`呼び出し後のタイムラグと待機要否**について、Developer Guideの「Resume behavior」節には「The MicroVM remains in SUSPENDED state while the `/resume` hook executes. After the hook returns HTTP 200, the MicroVM transitions to RUNNING and begins receiving traffic.」と明記されているのみで、仲介Lambda関数側が`ResumeMicrovm`呼び出し後に完了を待つべきか、fire-and-forgetでよいかについての明示的な推奨は無い。`ResumeMicrovm` API自体は「非同期」（既存調査`ai-lambda-microvms-api.md`参照）であり、呼び出し直後のレスポンスは処理の受理を意味するだけで、`RUNNING`到達の保証ではない。
- **具体的なサンプル実装の有無**について、Agent Skill・Developer Guide・AWS Compute Blogのいずれにも、「SQS→仲介Lambda→RunMicrovm/ResumeMicrovm」という構成そのもののサンプルコードやベストプラクティス集は見当たらなかった。AWS Compute Blogのサンプル（["Announcing Lambda MicroVMs"](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)）で示されているのは、データアナリストが対話的にAPIを呼ぶユースケース（`suspend-microvm`/`resume-microvm`をCLIで手動実行する例）であり、SQSトリガー型の自動化パターンの例ではない。

### 不明な点

- 「GetMicrovmで状態確認→分岐」という設計パターン自体を公式に推奨する一次情報は見当たらない。整合性は個々のAPI仕様から論理的に導けるが、AWSが公式にこのパターンを推奨・検証済みとして文書化しているわけではない。
- 複数の`RunMicrovm`/`ResumeMicrovm`呼び出しが競合した場合の具体的推奨対処（`ConflictException`を無視する、Lambdaの予約済み同時実行数を1に制限する等）についての明記は無い。
- `ResumeMicrovm`呼び出し後、仲介Lambda関数が完了を待つべきか、fire-and-forgetでよいかについての明示的なガイダンスは無い。
- 「SQS→仲介Lambda→RunMicrovm/ResumeMicrovm」という構成に特化した公式サンプル実装・ベストプラクティス集は確認できなかった。

## 参考リンク

- [SuspendMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_SuspendMicrovm.html)
- [ResumeMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ResumeMicrovm.html)
- [GetMicrovm APIリファレンス](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html)
- [Running and using MicroVMs（ライフサイクルフック、Suspend/Resume、Idle policy）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Networking（egress network connectors、デフォルトのINTERNET_EGRESS）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Security and permissions（IAMアクション一覧）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [Configuring reserved concurrency for a function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
- [Announcing Lambda MicroVMs（AWS Compute Blog）](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)
- AWS公式Agent Skill `aws-lambda-microvms`（`SKILL.md`「Known constraints」節、`references/lifecycle-model.md`、`references/iam-and-security.md`）
