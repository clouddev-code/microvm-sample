import datetime
import http.server
import json
import logging
import os
import threading
import time
import urllib.parse

import boto3
from botocore.exceptions import ClientError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")

# ビルド/ライフサイクルフックは、アプリ本体とは別のポートで待ち受ける（公式サンプルの構成に合わせる）。
# このワーカーはHTTPで外部からアプリトラフィックを受けないため、フック専用ポートのみを起動する。
HOOKS_PORT = int(os.environ.get("HOOKS_PORT", "9000"))
REGION = os.environ.get("AWS_REGION", "ap-northeast-1")
QUEUE_URL = os.environ["SQS_QUEUE_URL"]
TABLE_NAME = os.environ["DYNAMODB_TABLE_NAME"]
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-haiku-4-5-20251001-v1:0")

# MicroVMはビルド時（buildRoleでスナップショット取得）と実行時（executionRoleでレジューム）で
# 同一プロセスイメージを使い回す。モジュール読み込み時にboto3クライアントを生成すると、
# ビルド時（buildRoleコンテキスト）の認証情報がプロセスメモリに焼き付いたまま実行時に
# レジュームされてしまい、resume後もbuildRole権限のままSQS等のAPI呼び出しが失敗する。
# そのため、クライアント生成は/run・/resumeフック発火（実行ロールでの起動）後まで遅延させる。
sqs = None
s3 = None
bedrock = None
table = None

_poller_started = False
_poller_lock = threading.Lock()


def init_clients() -> None:
    global sqs, s3, bedrock, table
    sqs = boto3.client("sqs", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)
    bedrock = boto3.client("bedrock-runtime", region_name=REGION)
    table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)


def build_prompt(english_text: str) -> str:
    return (
        "以下の英語メッセージに日本語の解説を付けてください。"
        '前置きなしでJSON形式 {"original": "...", "japanese_explanation": "..."} のみを返してください。\n\n'
        f"Message: {english_text}"
    )


def call_bedrock(english_text: str) -> str:
    response = bedrock.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": build_prompt(english_text)}]}],
        inferenceConfig={"maxTokens": 512, "temperature": 0.3},
    )
    return response["output"]["message"]["content"][0]["text"]


def process_record(record: dict) -> None:
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

    obj = s3.get_object(Bucket=bucket, Key=key)
    english_text = obj["Body"].read().decode("utf-8")
    etag = obj["ETag"].strip('"')
    item_id = f"{bucket}/{key}#{etag}"

    explanation_raw = call_bedrock(english_text)

    try:
        table.put_item(
            Item={
                "id": item_id,
                "bucket": bucket,
                "key": key,
                "original_text": english_text,
                "japanese_explanation": explanation_raw,
                "model_id": MODEL_ID,
                "processed_at": datetime.datetime.utcnow().isoformat(),
            },
            ConditionExpression="attribute_not_exists(id)",
        )
        log.info("processed %s", item_id)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            log.info("already processed, skipping: %s", item_id)
        else:
            raise


def poll_loop() -> None:
    log.info("poll loop starting. queue=%s", QUEUE_URL)
    while True:
        try:
            resp = sqs.receive_message(
                QueueUrl=QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=20
            )
            for message in resp.get("Messages", []):
                receipt_handle = message["ReceiptHandle"]
                try:
                    body = json.loads(message["Body"])
                    for record in body.get("Records", []):
                        if record.get("eventSource") == "aws:s3":
                            process_record(record)
                except Exception:
                    log.exception("failed to process message; leaving for redelivery")
                    continue
                sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
        except Exception:
            log.exception("poll loop iteration failed; backing off")
            time.sleep(5)


def ensure_poller_started() -> None:
    global _poller_started
    with _poller_lock:
        if not _poller_started:
            init_clients()
            threading.Thread(target=poll_loop, daemon=True).start()
            _poller_started = True


class HooksHandler(http.server.BaseHTTPRequestHandler):
    def _respond(self, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        if self.path.endswith("/ready"):
            # ビルド検証時はビルドロール（SQS/DynamoDB/Bedrock権限なし）でコンテナが起動するため、
            # ここではポーリングを開始せず単純な生存確認のみ行う。
            self._respond(200)
        else:
            self._respond(404)

    def do_POST(self):
        self._read_body()
        if self.path.endswith("/ready"):
            self._respond(200)
        elif self.path.endswith("/validate"):
            self._respond(200)
        elif self.path.endswith("/run") or self.path.endswith("/resume"):
            ensure_poller_started()
            self._respond(200)
        elif self.path.endswith("/suspend") or self.path.endswith("/terminate"):
            self._respond(200)
        else:
            self._respond(404)

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)


if __name__ == "__main__":
    # ポーリングはコンテナ起動時ではなく、/run・/resumeフック（実行ロールで呼び出される）で開始する。
    server = http.server.ThreadingHTTPServer(("0.0.0.0", HOOKS_PORT), HooksHandler)
    log.info("hooks listening on port %d", HOOKS_PORT)
    server.serve_forever()
