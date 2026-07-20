import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';

// 常駐SQSワーカー(S3MicrovmAsyncStack)とは独立したPoC。HTTPエンドポイントへの着信リクエストに
// 同期応答するだけのFlask hello worldアプリで、AWSリソースへは一切アクセスしない。
// idle-suspendは着信トラフィックの有無でのみ判定されるため(TODO.md参照)、着信トラフィックが
// 存在しないSQSワーカーとは対照的に、このアプリではidle-suspend機構が実際に機能する。
export class SyncHelloWorldStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    // --- アプリコード資産（Dockerfile + app.py をCDKが自動でzip化しS3へアップロード） ---
    const appAsset = new Asset(this, 'SyncAppCodeAsset', {
      path: path.join(__dirname, '..', '..', 'microvm-sync-app'),
    });

    // --- ビルドロール（/ready, /validate フック実行時にMicroVMsが引き受ける） ---
    const buildRole = new iam.Role(this, 'SyncBuildRole', {
      roleName: 'sync-hello-world-build-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // 通常のLambda実行ロールと異なり、MicroVMsはsts:TagSessionも必要とする
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['sts:TagSession'],
      }),
    );
    appAsset.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    // --- 実行ロール（/run, /suspend, /resume, /terminate フック実行時） ---
    // Hello worldアプリはAWS APIを一切呼び出さないため、CloudWatch Logs権限のみ付与する。
    const executionRole = new iam.Role(this, 'SyncExecutionRole', {
      roleName: 'sync-hello-world-execution-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    executionRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['sts:TagSession'],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    // --- MicroVMイメージ定義 ---
    const appImage = new lambda.CfnMicrovmImage(this, 'SyncAppImage', {
      name: 'sync-hello-world-app',
      description: 'HTTPエンドポイントにHello Worldを同期応答するFlaskアプリ（idle-suspend検証用PoC）',
      // S3MicrovmAsyncStackと同じベースイメージ（実在確認済み、2026-07時点、us-west-2）。
      baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
      baseImageVersion: '0',
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: `s3://${appAsset.s3BucketName}/${appAsset.s3ObjectKey}`,
      },
      // AWS::Lambda::MicrovmImageは現状ARM_64のみをサポート（x86_64は不可）。
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      egressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
      environmentVariables: [
        { key: 'HOOKS_PORT', value: '9000' },
        { key: 'APP_PORT', value: '8080' },
      ],
      // hooks.portはアプリ本体のポート(8080)とは分離する
      // （フック用ポート共用が/readyタイムアウトの原因になった実機教訓、README.md参照）。
      hooks: {
        port: 9000,
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds: 60,
          validate: 'ENABLED',
          validateTimeoutInSeconds: 60,
        },
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: 30,
          suspend: 'ENABLED',
          suspendTimeoutInSeconds: 30,
          resume: 'ENABLED',
          resumeTimeoutInSeconds: 30,
          terminate: 'ENABLED',
          terminateTimeoutInSeconds: 30,
        },
      },
      logging: { disabled: false },
      resources: [{ minimumMemoryInMiB: 512 }],
      additionalOsCapabilities: [],
    });

    // 実行中インスタンス（RunMicrovm）はCDK/CloudFormationのリソースとして存在しないため、
    // デプロイ後にCLI/SDKで別途起動する（README参照）。
    new cdk.CfnOutput(this, 'SyncAppImageName', { value: appImage.name });
    new cdk.CfnOutput(this, 'SyncAppImageArn', { value: appImage.attrImageArn });
    new cdk.CfnOutput(this, 'SyncExecutionRoleArn', { value: executionRole.roleArn });
  }
}
