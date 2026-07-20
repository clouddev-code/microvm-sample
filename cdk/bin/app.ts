#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3MicrovmAsyncStack } from '../lib/s3-microvm-async-stack';
import { SyncHelloWorldStack } from '../lib/sync-hello-world-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

new S3MicrovmAsyncStack(app, 'S3MicrovmAsyncStack', { env });
new SyncHelloWorldStack(app, 'SyncHelloWorldStack', { env });
