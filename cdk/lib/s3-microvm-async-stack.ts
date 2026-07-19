import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';

// Claude Haiku 4.5はオンデマンドスループット非対応のため、クロスリージョン推論プロファイルIDを使う
// （`aws bedrock list-inference-profiles`で確認済み）。
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_UNDERLYING_FOUNDATION_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

export class S3MicrovmAsyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    // --- S3 -> SQS（Lambda不要のネイティブ連携） ---
    const uploadDlq = new sqs.Queue(this, 'UploadDlq', {
      queueName: 's3-microvm-async-upload-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const uploadQueue = new sqs.Queue(this, 'UploadQueue', {
      queueName: 's3-microvm-async-upload-queue',
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: { queue: uploadDlq, maxReceiveCount: 5 },
    });

    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      // S3バケット名はグローバルで一意である必要があるため、アカウントID/リージョンをサフィックスに含める。
      bucketName: `s3-microvm-async-upload-${this.account}-${region}`,
      // プロトタイプ用の設定。本番では明示的なライフサイクル管理に置き換えること。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(uploadQueue),
      { prefix: 'messages/' },
    );

    // --- DynamoDB（処理結果の登録先） ---
    const resultsTable = new dynamodb.Table(this, 'ResultsTable', {
      tableName: 's3-microvm-async-results',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // プロトタイプ用
    });

    // --- MicroVMワーカーのコード資産（Dockerfile + app.py をCDKが自動でzip化しS3へアップロード） ---
    const workerAsset = new Asset(this, 'WorkerCodeAsset', {
      path: path.join(__dirname, '..', '..', 'microvm-worker'),
    });

    // --- ビルドロール（/ready, /validate フック実行時にMicroVMsが引き受ける） ---
    const buildRole = new iam.Role(this, 'MicrovmBuildRole', {
      roleName: 's3-microvm-async-build-role',
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
    workerAsset.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    // --- 実行ロール（/run, /suspend, /resume, /terminate フック実行時 & ワーカーコードが使用） ---
    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      roleName: 's3-microvm-async-execution-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    executionRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['sts:TagSession'],
      }),
    );
    uploadQueue.grantConsumeMessages(executionRole);
    uploadBucket.grantRead(executionRole);
    resultsTable.grantWriteData(executionRole);
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          // 推論プロファイル本体（このアカウント・リージョンに紐づく）
          `arn:aws:bedrock:${region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
          // クロスリージョン推論プロファイルが実際にルーティングする先の基盤モデル（リージョン横断でAWS管理）
          `arn:aws:bedrock:*::foundation-model/${BEDROCK_UNDERLYING_FOUNDATION_MODEL_ID}`,
        ],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    // --- MicroVMイメージ定義（現状CloudFormation/CDKで宣言的に管理できるのはイメージのみ） ---
    // ワーカーはSQS受信・DynamoDB書き込み・Bedrock呼び出しのみを行い、VPC内プライベートリソースへは
    // アクセスしない。VPC_EGRESS型のNetwork ConnectorはRDS等プライベートVPCリソースへの到達が
    // 必要な場合にのみ使うものなので、自前VPC・SecurityGroup・NetworkConnectorは作成せず、
    // AWS管理の固定ARNコネクタ(INTERNET_EGRESS)でパブリックインターネット経路にする。
    const workerImage = new lambda.CfnMicrovmImage(this, 'WorkerImage', {
      name: 's3-microvm-async-worker',
      description:
        'S3にアップロードされた英語メッセージをSQS経由で受け取り、' +
        'Bedrock Claude Haiku 4.5で日本語解説を付与しDynamoDBへ登録するワーカー',
      // `aws lambda-microvms list-managed-microvm-images` / `list-managed-microvm-image-versions`
      // で実在を確認済み（2026-07時点、us-west-2）。
      // CDKのL1型ではbaseImageVersionは必須（省略不可）。`aws lambda-microvms
      // list-managed-microvm-image-versions --image-identifier <baseImageArn>`で確認した結果、
      // al2023-1には"0"のみが存在し、それが最新版でもある（2026-07時点、us-west-2）。
      baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
      baseImageVersion: '0',
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: `s3://${workerAsset.s3BucketName}/${workerAsset.s3ObjectKey}`,
      },
      // AWS::Lambda::MicrovmImageは現状ARM_64のみをサポート（x86_64は不可）。
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      egressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
      // AWS_REGIONはLambda MicroVMsのランタイムが予約しており明示指定できないため、
      // ワーカー側（app.py）のランタイム注入値フォールバックに任せる。
      environmentVariables: [
        { key: 'SQS_QUEUE_URL', value: uploadQueue.queueUrl },
        { key: 'DYNAMODB_TABLE_NAME', value: resultsTable.tableName },
        { key: 'BEDROCK_MODEL_ID', value: BEDROCK_MODEL_ID },
        { key: 'HOOKS_PORT', value: '9000' },
      ],
      // Ready/Validate/Run/Suspend/Resume/Terminateは"ENABLED"/"DISABLED"のenumで、
      // 値はパスではなくAWS側で固定された /ready /validate /run /suspend /resume /terminate への
      // POST呼び出しを行うかどうかのスイッチ（ワーカー側は既にこれらの固定パスを実装済み）。
      // hooks.portはアプリ本体のポートとは分離する（公式サンプルは常にhook専用ポートを使用しており、
      // アプリポートとの共用構成は検証されていない）。このワーカーはHTTPアプリトラフィックを
      // 持たないため9000番のみを使用する。
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
    new cdk.CfnOutput(this, 'MicrovmImageName', { value: workerImage.name });
    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: workerImage.attrImageArn });
    new cdk.CfnOutput(this, 'MicrovmExecutionRoleArn', { value: executionRole.roleArn });
    new cdk.CfnOutput(this, 'UploadBucketName', { value: uploadBucket.bucketName });
    new cdk.CfnOutput(this, 'UploadQueueUrl', { value: uploadQueue.queueUrl });
    new cdk.CfnOutput(this, 'ResultsTableName', { value: resultsTable.tableName });
  }
}
