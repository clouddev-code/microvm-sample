# AWS Lambda MicroVMs vs AgentCore Browser / Code Interpreter 比較調査

> 対象: AWS Lambda MicroVMs（プレビュー、2026年6月発表、boto3サービス名`lambda-microvms`）と
> Amazon Bedrock AgentCore Browser Tool / Code Interpreter（マネージドサンドボックスサービス）の比較。
> 「ヘッドレスブラウザ自動化」「AIエージェントのコード実行サンドボックス（推論コスト削減パターン）」の
> 2ユースケースについて、生のLambda MicroVMsを自前構築する価値があるかを検討するための裏取り調査。

## 背景・調査の目的

Lambda MicroVMsの特徴は「①VMレベルの強い分離」「②Suspend/Resumeによるステートフルな一時停止・再開（メモリ・ディスク状態を保持したままコンピュート課金を止められる、最大8時間）」「③スナップショットベースの高速起動」の3点。この3機能の組み合わせが効くユースケース候補として「ヘッドレスブラウザ自動化」「AIエージェントのコード実行サンドボックス」を検討していたところ、両方ともAmazon Bedrock AgentCoreに相当するマネージドサービス（Browser Tool / Code Interpreter）が既に存在することが分かったため、正確な機能差分を裏取りした。

## AgentCore Browser Tool

### 分離モデル

公式ドキュメントの記載に**表現の揺れ**がある。概要ページでは「containerized environment」、セッション管理の詳細ページでは以下のように明記。

> "Each tool session runs in a dedicated microVM with isolated CPU, memory, and filesystem resources... Upon session completion, the microVM is fully terminated, and its memory is sanitized"

セッション単位で専用microVMが払い出されることは明記されているが、「Firecracker」という技術名の明示はこのページには無い。

参照: [Fundamentals（Session management）](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-resource-session-management.html) / [Browser Tool概要](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html) / [AWS ML Blog](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore-browser-tool/)

### セッションの状態管理（最重要）

- タイムアウトはデフォルト900秒（15分）、**最大28,800秒（8時間）まで設定可能**。
- 提供APIは`StartBrowserSession` / `StopBrowserSession` / `GetBrowserSession` / `ListBrowserSessions`のみで、**Pause/Suspend/Resume相当のAPIは存在しない**。
- 概要ページのセキュリティ機能欄に「Ephemeral sessions: Temporary sessions that reset after each use」と明記。**セッション終了＝状態消失モデル**。
- **結論: Lambda MicroVMsの「Suspend/Resumeで状態を保持したまま課金を止める」に相当する機能は公式ドキュメント上、存在しない。**

参照: [Managing Browser Sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-managing-sessions.html)

### CDP/Playwright/Selenium対応

`BrowserClient.generate_ws_headers()`でWebSocket URLと認証ヘッダーを取得し、`playwright.chromium.connect_over_cdp(ws_url, headers=headers)`で接続する方式が公式に例示されている。Playwright経由のCDP接続が正式サポートで、browser-useライブラリの利用も言及あり。Seleniumの明記は確認できなかった（不明点）。

参照: [Using AgentCore Browser with Playwright](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-quickstart-playwright.html)

### ライブビュー・セッションレコーディング

両方とも公式機能として存在。ライブビューはWebSocketエンドポイント（`/browser-streams/{browser_id}/sessions/{session_id}/live-view`）でリアルタイム閲覧・操作介入が可能。セッションレコーディングはDOM変化・ユーザー操作・コンソールログ・ネットワークイベントを記録しS3に保存、コンソール上でビデオ再生・タイムライン操作込みで再生可能。

参照: [Features](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-features.html)

### 料金体系

vCPU $0.0895/時間、メモリ $0.00945/GB時間の秒単位課金。CPUはI/O待機中は無課金だが、**メモリはセッション中継続的に課金**される（完全アイドルでも課金ゼロにはならない）。Browser Profile用S3ストレージやネットワーク転送は別途課金。

参照: [AgentCore Pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)

### Lambda MicroVMsとの関係

公式ドキュメント・公式ブログのいずれにも「Lambda MicroVMs」「RunMicrovm」「Firecracker」という単語は一切登場しない。確認できたのは「dedicated microVM」という一般的表現のみで、Lambda MicroVMs基盤の上に構築されているという明示的な言及は**明記なし**（第三者ブログにはFirecracker採用の推測記事があるが一次情報源ではないため対象外）。

## AgentCore Code Interpreter

### 分離モデル

Browser Toolと同様の表現の揺れ。[Session management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)には「Each tool session runs in a dedicated microVM with isolated CPU, memory, and filesystem resources... Upon session completion, the microVM is fully terminated, and its memory is sanitized」、[概要ページ](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)は「runs in a containerized environment」。"Firecracker"の明記があるとされる[How AgentCore Tools session isolation works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-tools-how-it-works.html)はJSレンダリングのため逐語確認はできなかった（確度高いが未直接検証）。

### 言語・ライブラリ

Python / JavaScript / TypeScript対応。[Pre-installed libraries](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-preinstalled-libraries.html)にpandas, numpy, scipy, scikit-learn等が多数プリインストール済み。Node.js側はaxios, lodash, uuid, zod, cheerio等。セッション内での追加パッケージインストールも可能（wkhtmltopdf等の例あり）。

### セッションの状態管理（最重要）

デフォルトタイムアウト900秒（15分）、最大8時間まで延長可能。「Files and data created during a session are available throughout the session's lifetime. When the session is terminated, the session no longer persists and the data is cleaned up」＝**セッション内ではステートフル**（複数回のコード実行間で変数・ファイルシステムが保持される）が、**セッション終了後は完全にクリーンアップされ復元不可**。提供APIは`stop-code-interpreter-session`のみで、Suspend/Pause/Resume系のAPIは無い。

**結論: AgentCore Code InterpreterにはLambda MicroVMs相当のSuspend/Resume機能は公式ドキュメント上確認できなかった。** Start/Stop（自動タイムアウト含む）のみ。

参照: [Session management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html) / [Stopping a session](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-stop-session.html)

### 料金体系

CPU $0.0895/vCPU-hour、Memory $0.00945/GB-hour（Browser Toolと同一体系）。秒単位課金・I/O待機無課金という説明は二次情報での言及があるが、pricingページのHTML自体には詳細文言が見当たらず裏取り不完全。

### ツール統合パターン

[Run code in Code Interpreter from Agents](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-building-agents.html)にStrands AgentsおよびLangChainでの実装例あり。`code_session()`コンテキストマネージャで`executeCode`を呼び、`clearContext: False`で状態を維持しながら通常の`@tool`関数としてラップしBedrock/ClaudeのTool use機構に統合するパターンが公式サンプルとして示されている。AgentCore Runtimeとの明示的な統合記述は確認範囲では見当たらなかった。

### Lambda MicroVMsとの関係

[Secure code execution for AI agents with AWS Lambda MicroVMs](https://aws.amazon.com/blogs/compute/secure-code-execution-for-ai-agents-with-aws-lambda-microvms/)（公式ブログ）はLambda MicroVMs／Agent Toolkit for AWS／AgentCore Policyの3層構成を説明するが、Code Interpreterへの言及は一切ない。**「Code InterpreterがLambda MicroVMs基盤上に構築されている」という明示的記載は一次情報源で確認できなかった。「明記なし」として扱う。**

## 公式ブログ「Secure code execution for AI agents with AWS Lambda MicroVMs」の詳細

一次情報源: https://aws.amazon.com/blogs/compute/secure-code-execution-for-ai-agents-with-aws-lambda-microvms/

### 3層アーキテクチャ

- **実行層（Lambda MicroVMs）**: Firecrackerベースの隔離環境で独自のkernel・filesystem・network namespaceを持つ。「Agents can run user sessions for up to 8 hours, with configurable network access」。
- **専門知識層（Agent Toolkit for AWS）**: 「gives coding agents validated, up-to-date procedures for AWS tasks」。AWS固有タスクの検証済み手順（skills）とAgent Plugin for AWS Serverlessを通じてIAM最小権限やObservabilityをデフォルトで組み込む。
- **ガバナンス層（AgentCore Policy）**: 「Policy in AgentCore intercepts every tool call at the Amazon Bedrock AgentCore Gateway and evaluates it against Cedar policies」。ツール呼び出しの境界で決定論的な統制をかける。ポリシー例:「A policy can permit an agent to call a deploy tool but deny it when the environment parameter is production」。判定はモデルのコンテキストやプロンプトに影響されない（"policy decisions are not influenced by the model's context or prompt"）。

### 想定ユースケース

記事はエージェントによるサーバーレスアプリケーションの生成・デプロイ・テスト（主にNode.js例、SAMテンプレート使用）を中心に据えている。**「LLMに生データを渡す代わりに集計・要約済み結果だけを返すことで推論コストを削減する」パターンへの言及は本文中に無い**（"aggregat"、"summar"、"token"、"cost"のキーワード検索でも該当なし）。

### Suspend/Resumeの扱い

言及は「MicroVMs can be suspended and resumed with their state preserved, giving agents state retention across sessions.」の一文のみ。「スナップショット」という語自体は本文に登場せず、ウォームプール維持やコスト最適化への具体的な活用方法についての記述も無い。

### AgentCore Code Interpreterとの比較

本文中に言及なし。なぜ素のLambda MicroVMsを使うのか、両者の住み分けについての説明は存在しない。

## 総合評価・使い分けの指針

### ヘッドレスブラウザ自動化

最大の差分は**Suspend/Resumeの有無**。AgentCore Browserは「使い切り」モデル（最大8時間・Ephemeral・終了で状態消失）。同一ログイン状態・Cookie・タブ構成を長い間隔を空けて使い回したい（定期バッチが同一認証済みセッションに戻る、人間の介入待ちで数時間放置される等）場合、AgentCore Browserでは毎回再ログイン等のオーバーヘッドが発生するが、Lambda MicroVMsならSuspendで状態を凍結し課金を止めつつ必要な時だけResumeで即復帰できる。

逆に単発〜数十分規模のタスクで、ライブビュー監視・セッションレコーディング・CDP実装済みのマネージド性が欲しい場合はAgentCore Browserが有利。自前でChrome＋CDP＋監視をLambda MicroVMs上に構築するコストは小さくない。

### コード実行サンドボックス（推論コスト削減パターン）

公式ブログはこのユースケース（集計コード実行による推論コスト削減）を明示的にカバーしていない。想定されるのは「1回のツール呼び出しでコードを書いて実行し結果だけ受け取る」単発パターンが多く、この場合はAgentCore Code Interpreterのプリインストール環境（pandas/numpy等）・マネージド性の方が実装コストで有利で、Suspend/Resumeの出番はほぼ無い。

Lambda MicroVMsが優位になり得るのは以下のような**状態を跨いで使い回す**シナリオに限られる。

- 数GB級データセットをメモリ/DataFrameにロード済みの状態を複数エージェントターン・複数リクエストにわたって使い回し、毎回のロードコストを避けたい
- Code Interpreterのプリインストールに収まらない特殊な依存関係・独自バイナリが必要
- 8時間の壁をSuspend挟みで実質的に延長したい継続ジョブ（ただし`suspendedDurationSeconds`にも上限があり無制限ではない点に注意）

## 追加検討: Claude Agent SDK（Bedrock経由）のブラウザ操作エージェントへの適用

> 本節は公式ドキュメントの裏取りではなく、advisorツール不可のためグローバルCLAUDE.mdの代替ポリシーに従い`Agent(model="fable")`に相談した**判断・仮説**である。事実確認済み部分（前段までの各節）とは性質が異なる点に留意。

### 検討したシナリオ

「認証済みブラウザセッションをSuspendで凍結→数時間後にResumeで即再開（再ログイン不要）」というパターンが、**Claude Agent SDK（モデル呼び出しはAmazon Bedrock経由のClaude）でブラウザを操作するエージェント**のユースケースに合うか。

### 判断: 方向性としては妥当、ただし本番前提なら要検証項目が多い

**成立の鍵はアーキテクチャの分離**: Claude Agent SDKのオーケストレーションループ（Bedrock呼び出し）はMicroVM内に置く必然性がなく、外部のツール呼び出し先としてMicroVM上のChromeにCDP経由で都度接続する構成にすべき、という判断。

### 優先して検証すべき2点（成否を直接左右）

1. **サーバー側セッションTTL**: MicroVM側でCookie/ローカルストレージを保持していても、対象サイトが独自にセッション有効期限を切っていればログアウトされる。MicroVMの状態保持とは無関係に発生しうるリスク。
2. **CDP接続の再確立設計**: 数時間のSuspendを挟めば、既存のCDP WebSocket（TCP）は**ほぼ確実に切断される**。「同じ接続が生き続ける」前提ではなく、**Resume後にCDPへ再接続する設計を最初から組み込む**必要がある。Resume時の時計ジャンプがJSタイマー・トークン有効期限・TLSセッションに影響する可能性もある。

→ 本格実装の前に、**「数時間Suspend→Resume→CDP再接続→認証状態が維持されているか」だけを検証する小さいPoC**を最初に行うべき、との判断。

### 見落としていた重大な点

- **プレビュー機能であること自体**（SLA無し、API仕様変更の可能性、リージョン制約、GA時期不明）が、本番運用を前提にするなら最上位の留意点。本プロジェクト自体がこの前提の上にある。
- **Suspendスナップショットへの認証情報の扱い**: 認証Cookie/トークンがメモリごとスナップショットに保存されるため、スナップショットの暗号化・アクセス制御（IAM）がどうなっているかは未確認。公式ドキュメント上、この観点の裏取りはできていない。

### その他の留意点（既存の総合評価と同じ）

- `suspendedDurationSeconds`をResume予定間隔より長く設定する必要がある（超過でTERMINATED＝状態消失）
- AgentCore Browserのライブビュー・レコーディング機能は自前構築では失われる
- 複数セッションを扱うならセッション⇔MicroVMのマッピング・プーリングを自前実装する必要がある

## 追加検討: 「数GB級データロード済み状態の複数ターン再利用」の具体的アプリケーション例

> 本節も公式ドキュメントの裏取りではなく、既存の使い分け整理（コード実行サンドボックス節）を踏まえた検討・ブレインストーミングである。

### 成立条件

このパターンが効くための本質的な条件は「**ターン間に人間の思考時間などの空白（分〜時間単位）があり、かつリロードコストが体感的に無視できないほど大きい**」こと。空白がなければ単にVMをRUNNING維持すればよくSuspend/Resumeの出番はなく、空白があっても毎回のロードが数秒で済むなら不要。

### 具体例

1. **対話型BI／「データに質問する」エージェント**: 数GBのCSV/Parquetをアップロードし、「先月の売上は」→「地域別で見ると」→「前年同期比は」と対話的に深掘り。ユーザーの入力待ち（分単位）の間、同じDataFrameをロードしたまま凍結できる。
2. **インシデント調査・ログ分析エージェント**: 数GB規模のアクセスログ/監査ログをメモリ上のDuckDB等に展開し、調査担当者が対話的に掘り下げる。調査は数時間〜数日単位で断続的に行われることが多い。
3. **RAGのオンメモリベクトルインデックス（テナント専用）**: テナントごとに数百万件規模の埋め込み（数GB）を専用インデックスとしてロードし、そのテナントからの検索リクエストに繰り返し応答。マルチテナントで共有できない・したくない場合に特に効く。
4. **会計・取引データの監査エージェント**: 大量の取引データをロードし、仕訳の整合性チェックや異常検知を複数ターンにわたって実行。
5. **カスタマーサポート/CRMの文脈保持エージェント**: 特定顧客の大きな対話履歴・注文履歴をロードし、同一顧客に関する複数の問い合わせに順次対応。顧客対応は日をまたぐこともある。
6. **大規模モノレポのコード解析エージェント**: AST・シンボルインデックス・埋め込みをメモリに保持し、開発者との複数ターンのやり取りに高速応答。

### 判断基準

共通するのは「**個人・特定セッションに紐づく専用の重い状態**」であること。この条件を満たさない（グローバル共有データ、ステートレスな単発クエリ）場合は、DB/キャッシュサービスやAgentCore Code Interpreterの使い切りモデルの方がシンプルで運用コストも低い。

## 不明な点（まとめ）

- AgentCore Browser / Code InterpreterがFirecracker技術を採用しているという明示は、間接的な言及（"dedicated microVM"）はあるが、技術名としての明記はJSレンダリングページのため直接確認できていない。
- AgentCore Browser / Code InterpreterがLambda MicroVMs基盤の上に構築されているかどうかは、一次情報源では明記が無い（否定も肯定もされていない）。
- Code Interpreterの秒単位課金・I/O待機無課金の詳細は二次情報のみで、pricingページ本文では未確認。

## 参考リンク

- [Fundamentals（Browser Session management）](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-resource-session-management.html)
- [Browser Tool概要](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html)
- [Managing Browser Sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-managing-sessions.html)
- [Browser Tool Features](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-features.html)
- [Using AgentCore Browser with Playwright](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-quickstart-playwright.html)
- [Introducing Amazon Bedrock AgentCore Browser Tool（AWS Blog）](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore-browser-tool/)
- [Code Interpreter Session management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)
- [Code Interpreter概要](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [Code Interpreter Pre-installed libraries](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-preinstalled-libraries.html)
- [Stopping a Code Interpreter session](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-stop-session.html)
- [Run code in Code Interpreter from Agents](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-building-agents.html)
- [Amazon Bedrock AgentCore Pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
- [Secure code execution for AI agents with AWS Lambda MicroVMs（AWS Compute Blog）](https://aws.amazon.com/blogs/compute/secure-code-execution-for-ai-agents-with-aws-lambda-microvms/)
- [AWS Lambda MicroVMs core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
