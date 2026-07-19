# TODO

## MicroVMのidle-suspend機構がSQSワーカーに効かない問題

**現状の課題**:
`run-microvm`の`--idle-policy`（`maxIdleDurationSeconds`等）は、MicroVMの**公開HTTPSエンドポイントへの着信トラフィックの有無**でidle判定する仕組みであり、CPU使用率やプロセスの活動状況は見ていない（[MicroVM images (Running and using MicroVMs)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)より）。

> Note: For asynchronous applications that do not actively send or receive traffic through the endpoint, disable automatic suspension or configure a suitable idle duration.

`microvm-worker`はSQSをポーリングする非同期ワーカーで、公開エンドポイントへのHTTP着信が発生しないため、idle-policyによる自動suspendは実質的に機能しない。`maximumDurationInSeconds`（最大8時間）で強制terminateされるまで動き続けるか、明示的にsuspendしない限り止まらない。

**方針決定（2026-07-12）**: 外部（仲介Lambda＋EventBridge Scheduler）から`suspend-microvm`/`resume-microvm`を呼び出す方式を採用する。ワーカー自身による自己suspendは、公式Agent Skillが「No self-suspend from inside the MicroVM. Call from outside.」と明記して非推奨としているため不採用。
決定の経緯は `.claude/HANDOFF.md` 参照（advisorツール利用不可のため `Agent(model="fable")` で判断相談）。**まだ実装には着手していない。**

**対応案**（未実装）:
- [x] ~~SQSキューが空になったタイミングでワーカー自身が`suspend-microvm`をAPI呼び出しする実装を追加する~~ → 不採用（公式非推奨パターンのため）
- [ ] `idlePolicy`省略＋仲介Lambda（既存のSQS→Run/Resume用）にSuspend判断も集約し、EventBridge Schedulerで定期チェック（例: 5分毎にキュー空＋一定時間経過で`suspend-microvm`）する仕組みを実装する
- [ ] Suspend実行前のキュー深度再確認によるレース対策、Suspend後の着信は既存Resume経路で救済する設計にする
- [ ] 8時間の`maximumDurationInSeconds`上限に達した際の自動再起動（再度`run-microvm`する仕組み）も未実装（`cdk/.claude/HANDOFF.md`の残タスク1と同一）
