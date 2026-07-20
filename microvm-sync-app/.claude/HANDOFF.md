# HANDOFF (microvm-sync-app)

> このファイルはセッション引き継ぎ用。コンテキスト圧迫時に随時更新すること。
> 最終更新: 2026-07-20 13:00頃 JST — **本タスクは完了。以下は完了までの経緯の記録。**

## タスク概要

既存の常駐SQSワーカー（`microvm-worker/`、`S3MicrovmAsyncStack`）とは別に、
**HTTPエンドポイントに同期応答するFlask hello world**のPoC環境を新規作成する依頼。
既存ワーカーは着信HTTPトラフィックが無いためidle-suspendが機能しない既知課題があり
（`TODO.md`参照）、今回のアプリは実際にHTTPで着信するため**idle-suspendが正しく機能する対比デモ**
という位置づけ。

## 構成（作成済みファイル）

- `microvm-sync-app/app.py` — Flask hello world。`microvm-worker/app.py`と同じ流儀で、
  フック用HTTPサーバー（ポート9000、`/ready`/`/validate`/`/run`/`/suspend`/`/resume`/`/terminate`）と
  アプリ本体（Flask、ポート8080）を分離。Flaskは`/run`・`/resume`フックで別スレッド起動
  （`ensure_app_started()`、`threading`ベース、gunicorn不使用 — advisor代替
  `Agent(model="fable")`の助言により、suspend/resume挙動の切り分けを単純にするため）。
  AWS APIは一切呼び出さないため、boto3遅延生成のような罠は無関係。
- `microvm-sync-app/pyproject.toml` / `uv.lock` — **uvでパッケージ管理**（ユーザー指示により
  requirements.txt+pipから変更）。依存は`flask>=3.0.0`のみ。
- `microvm-sync-app/Dockerfile` — 後述の「重要な決定事項・トラブル」参照。
- `cdk/lib/sync-hello-world-stack.ts` — 新規CDK Stack。`S3MicrovmAsyncStack`とはStack間参照ゼロで
  完全独立。専用のbuildRole/executionRole（CloudWatch Logsのみ、S3/SQS/DynamoDB/Bedrock権限なし）、
  専用の`CfnMicrovmImage`（`name: sync-hello-world-app`）。
- `cdk/bin/app.ts` — `S3MicrovmAsyncStack`と`SyncHelloWorldStack`を同一App内に並列インスタンス化する形に変更。
- `README.md` — 構成説明・デプロイ手順（`cdk deploy --all`または個別スタック指定）・
  `run-microvm`起動コマンド（`SyncHelloWorldStack`用は`maxIdleDurationSeconds: 60`と短めに設定し
  idle-suspend検証を短時間で回せるようにした）・動作確認手順（`get-microvm`でendpoint取得→curl→
  60秒待ってSUSPENDED確認→再度curlでauto-resume確認）・`terminate-microvm`での後片付け手順・
  「実機デプロイで判明した罠」に4番目の罠を追記済み。

## アーキテクチャ判断の経緯

advisorツールが利用不可（"temporarily disabled"）だったため、CLAUDE.mdの代替ポリシーに従い
`Agent(model="fable")`に以下を相談し承認を得た。

1. 同一CDK App内に別Stackとして同居させる（App分離は不要）→ **承認**
2. `ingressNetworkConnectors`に`ALL_INGRESS`を使う（PoCなので認証は簡略化）→ **条件付き承認**
   （エンドポイントURLをコミットしない、検証後terminateする、をREADMEに明記する条件）
3. Flask起動はthreading方式（gunicorn不使用）、suspend/resumeフックにログを仕込む → 反映済み
4. `maxIdleDurationSeconds`は短め（60〜120秒）に → 60秒で反映済み

## 実装検証状況

- **ローカルDocker検証: 完了・成功**。`docker build`→コンテナ起動→
  `/run`フック→Flask起動確認→`curl`でHello World応答確認→`/suspend`→`/resume`→
  再度`curl`で応答確認、まで一連の流れをローカルで確認済み（後述のDockerfile修正版で再検証済み）。
- **AWS実機デプロイ: 進行中・トラブル発生中**（下記参照）。

## 重要な決定事項・トラブル: ghcr.io到達不可によるビルドハング

### 発生した問題
初版のDockerfileは`COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/`で
uvバイナリを取得する構成だった。`cdk deploy`実行後、`SyncHelloWorldStack`の
`AWS::Lambda::MicrovmImage`（`SyncAppImage`）が**30分以上`CREATE_IN_PROGRESS`のまま停滞**し、
最終的にCloudFormationが`Exceeded attempts to wait`（`HandlerErrorCode: NotStabilized`）で
`CREATE_FAILED`になった。さらにロールバック（自動DELETE）も`DELETE_FAILED`
（`HandlerErrorCode: GeneralServiceException`）となり、**スタックが`ROLLBACK_FAILED`に陥った**。

### 診断で確認した事実
- `aws lambda-microvms list-microvm-image-builds`で確認すると、`buildState`は`IN_PROGRESS`のまま
  変化がなかった（FAILED等の明確なエラー状態にすら到達していない＝ハングしていると推定）。
- 正常にビルドできた既存の`s3-microvm-async-worker`イメージでは、ビルド開始とほぼ同時に
  CloudWatch Logsロググループ（`/aws/lambda-microvms/s3-microvm-async-worker`）が作成されていたが、
  `sync-hello-world-app`用のロググループは30分経過しても作成されていなかった
  （＝ビルドのかなり早い段階、おそらくDockerイメージのpull/build自体で止まっていると推定）。
- `delete-microvm-image-version`は「This is the last version. Please delete the entire image」、
  `delete-microvm-image`は「Cannot delete MicroVM image in its current state」でいずれも失敗。
  **`IN_PROGRESS`状態のビルドをキャンセルするAPIは存在しない**（`list-microvm-images`ヘルプに
  cancel系コマンドなし）。ビルドが自然に終了する（成功/失敗いずれか）まで待つ以外の回避策なし。

### 推定原因（未確定・検証中）
既存ワーカーの`microvm-worker/Dockerfile`は`public.ecr.aws`（ベースイメージ）と
PyPI（`pip install -r requirements.txt`でboto3等を取得）のみに依存しており、ビルド成功実績がある。
一方、新Dockerfileだけが`ghcr.io`（GitHub Container Registry）への到達を必要としていた。
この差分から、**AWS Lambda MicroVMsのイメージビルド環境は`ghcr.io`に到達できず、
ビルドがハングしている**という仮説を立てた（確定ではない。他の要因の可能性も排除できていない）。

### 対応済みの修正
`microvm-sync-app/Dockerfile`を、`ghcr.io`から`COPY --from`する方式ではなく、
**PyPI経由（`python3.13 -m pip install uv`）でuv本体を取得する方式**に変更した。
ローカルで`docker build --no-cache`→コンテナ起動→`/run`→Flask起動→`curl`応答確認まで
再検証し、成功を確認済み。`README.md`「実機デプロイで判明した罠」の4番目にこの経緯を記録済み
（ただし「推定原因、検証中」と明記し、断定はしていない）。

## 現在進行中のバックグラウンド作業

Bash `run_in_background`で、停滞している`sync-hello-world-app`（v1.0）のビルド状態を
30秒間隔・最大120回（=最大60分）ポーリングするジョブを起動済み（タスクID: `b0y21cjoc`、
出力ファイル: `/private/tmp/claude-501/-Users-hiruta-work-microvm-test/034be113-c0a9-41dc-bd03-a712deb82f41/tasks/b0y21cjoc.output`）。
`buildState`が`IN_PROGRESS`以外に変化するか、タイムアウトするとバックグラウンド通知が来る設計。
このHANDOFF更新時点（12:07頃）ではまだ`IN_PROGRESS`が継続中。

## 追記（2026-07-20 12:30頃）: ghcr.io仮説は確認された。デプロイ・起動まで成功

- ユーザーがCFN`ROLLBACK_FAILED`だったスタックを手動削除完了（確認済み）。
- 修正済みDockerfile（PyPI経由でuv取得）で`cdk deploy SyncHelloWorldStack`を再実行 →
  **約2.5分でCREATE_COMPLETE**（前回は30分以上ハング）。`/aws/lambda-microvms/sync-hello-world-app`
  ロググループもビルド開始から約3分半で出現。**「ghcr.io到達不可でビルドがハングする」仮説は
  強く裏付けられた**（README.md「実機デプロイで判明した罠」4番目を「確定」トーンに更新推奨、未実施）。
- `run-microvm`実行 → `microvmId: microvm-869315b5-148f-38f3-9046-d70a16ab9a49`が
  即座に`RUNNING`に遷移。
- **未解決の新問題**: エンドポイントへの`curl`が`403 Request missing authentication`で失敗。
  `aws lambda-microvms create-microvm-auth-token --microvm-identifier <id>
  --expiration-in-minutes 15 --allowed-ports 8080`でトークン発行はできたが、
  `Authorization: Bearer <token>`ヘッダーを付けて`https://<endpoint>:8080/`にcurlしたところ
  **2分でタイムアウト**（応答なし）。ホスト名に`:8080`を付与する方式が誤っている可能性が高い
  （公式ドキュメントに「invalid port header」という文言があり、URLのポート番号ではなく
  専用HTTPヘッダーでポート指定する方式の可能性がある。次回セッションで
  `research/ai-lambda-microvms-network-connector-types.md`の参照元
  `microvms-networking.html`を`aws-researcher`で再調査し、正しいポート指定方法
  （ヘッダー名、`create-microvm-auth-token`のトークンの正しい渡し方）を確認すること）。
- 動作未確認のまま、時間の都合でMicroVM（`microvm-869315b5-148f-38f3-9046-d70a16ab9a49`）は
  `terminate-microvm`済み（確認済み、exit code 0）。次回セッションでは新たに`run-microvm`から
  やり直す必要がある。
- idle-suspend自体の動作確認（60秒待ってSUSPENDED→再curlでauto-resume）は**未実施**
  （エンドポイント到達方法が先に解決する必要がある）。

## 追記（2026-07-20 13:00頃）: 完了。エンドポイント認証方法を確定、動作確認一式を完遂

- `aws-researcher`エージェントによる調査で原因確定
  （`research/ai-lambda-microvms-http-endpoint-auth.md`に詳細を記録済み）。
  - ポート指定は`X-aws-proxy-port`ヘッダー（`get-microvm`の`endpoint`はホスト名のみ、常にHTTPS）。
  - 認証トークンは`Authorization: Bearer`ではなく`X-aws-proxy-auth`ヘッダー。
  - `create-microvm-auth-token`のレスポンスは`{"authToken":{"X-aws-proxy-auth":"<JWE>"}}`という
    構造で、トップレベルの`token`フィールドではない（`--query 'authToken."X-aws-proxy-auth"'`で取得）。
  - 副次的にもう1点判明: `run-microvm`の`--image-identifier`はイメージ名だけでは
    `Malformed ARN`で拒否される。フルARN（`SyncAppImageArn`出力値）が必要。
- 新規`run-microvm`実行（`microvm-ca0911d6-e03e-3e88-85ca-c7d3f32f68bd`）→即`RUNNING`。
- 正しいヘッダーでcurl→**`{"message":"Hello, World!"}`を200で確認（成功）**。
- リクエストを送らず75秒待機→`get-microvm`で`state=SUSPENDED`を確認
  （`maxIdleDurationSeconds:60`通りにidle-suspendが機能することを実機確認）。
- 再度同じ`curl`を送信→**約1.1秒でauto-resumeし`RUNNING`に復帰、Hello World応答を確認（成功）**。
- `terminate-microvm`実行、`TERMINATING`遷移を確認して後片付け完了。
- `README.md`「実機デプロイで判明した罠」を更新: 4番目（ghcr.io仮説）を確定トーンに変更、
  5番目（image-identifierはARN必須）・6番目（X-aws-proxy-*ヘッダー）を新規追加。
  「動作確認」セクションのコマンド例もヘッダー付きcurlに修正済み。

### idle-suspend機構自体の評価（今回の対比デモの目的に対する結論）

常駐SQSワーカー（`microvm-worker`）とは異なり、実際にHTTP着信があるアプリでは
`autoResumeEnabled:true`のidle-suspendが設計通りに機能することを実機で確認できた。
これにより「常駐SQSワーカーでidle-suspendが効かない」（`TODO.md`記載の既知課題）が
アプリ側の通信パターンに起因するものであり、MicroVMs機能自体の欠陥ではないことの
傍証も得られた。

## （旧）次にやるべきこと（達成済み・参考として残す）

1. ~~MicroVMエンドポイントへの正しいアクセス方法を確認する~~ → 完了。
2. ~~`run-microvm`からやり直し、Hello World応答→idle-suspend→auto-resume→`terminate-microvm`~~ → 完了。
3. ~~README.md「実機デプロイで判明した罠」4番目を確定トーンに更新する~~ → 完了。

## （旧）次にやるべきこと（このビルドが終了したら、達成済み・参考として残す）

1. バックグラウンドポーリングの結果を確認する（通知が来ているはず。無ければ
   `aws lambda-microvms list-microvm-image-builds --region us-west-2 --image-identifier arn:aws:lambda:us-west-2:905860205176:microvm-image:sync-hello-world-app --image-version 1.0`
   で手動確認）。
2. ビルドが`FAILED`等になったら、`aws cloudformation delete-stack --stack-name SyncHelloWorldStack --region us-west-2`
   で`ROLLBACK_FAILED`スタックの削除を再試行する（前回は`SyncAppImage`が`IN_PROGRESS`のため
   `DELETE_FAILED`だったが、ビルド終了後は成功するはず）。
3. スタック削除完了を確認後（`aws cloudformation describe-stacks`で`DELETE_COMPLETE`or
   スタック自体が消える）、修正済みDockerfileで`cd cdk && npx cdk deploy SyncHelloWorldStack`
   を再実行する（Node実行には`source ~/.nvm/nvm.sh; nvm use 22.22.2`が必要、CLAUDE.md指示）。
4. 再デプロイ後、今度こそビルドが正常完了するか（ロググループが即座に作成されるか、
   `buildState`が`SUCCEEDED`になるか）を確認する。もし再度ハングした場合は、
   「ghcr.io到達不可」仮説が誤りである可能性が高く、別の原因（Dockerfile構文、
   `uv sync --locked`のネットワークアクセス有無、等）を再調査する必要がある。
5. ビルド成功後、README.md記載の手順で`run-microvm`実行→`curl`でHello World確認→
   idle-suspend（60秒）→auto-resume確認→`terminate-microvm`まで一通り実施する。
6. 上記4の「推定原因、検証中」を、確定した事実に基づいて確定表現に更新する（README.md
   「実機デプロイで判明した罠」4番目）。
7. 全て確認できたら、このファイル（`microvm-sync-app/.claude/HANDOFF.md`）に完了ステータスを追記する。

## 参考: 現在のAWS環境情報

- アカウント: `905860205176`、リージョン: `us-west-2`（`cdk/bin/app.ts`のデフォルトは
  `ap-northeast-1`だが、`CDK_DEFAULT_REGION`未設定時はAWS CLIのデフォルトリージョン
  `us-west-2`が使われた形跡があり、既存の`S3MicrovmAsyncStack`も`us-west-2`にデプロイ済み）。
- 停滞中のリソース: `arn:aws:lambda:us-west-2:905860205176:microvm-image:sync-hello-world-app`
  （imageVersion `1.0`、buildId `223a43a4-dfd7-43c2-8b9f-5430bb368e53`(GRAVITON3)、
  `a122dbf1-7096-4e4f-81e5-a64cbc42f873`(GRAVITON4)、いずれも`IN_PROGRESS`）。
- CFNスタック`SyncHelloWorldStack`: `ROLLBACK_FAILED`→`delete-stack`実行済みだが
  `SyncAppImage`が`IN_PROGRESS`のため`DELETE_FAILED`のまま。
