#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3MicrovmAsyncStack } from '../lib/s3-microvm-async-stack';

const app = new cdk.App();

new S3MicrovmAsyncStack(app, 'S3MicrovmAsyncStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});
