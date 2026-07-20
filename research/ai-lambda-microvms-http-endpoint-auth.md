# AWS Lambda MicroVMs: HTTPエンドポイントへの正しいアクセス方法

## 概要

AWS Lambda MicroVMs（プレビュー）のHTTPエンドポイントへのアクセスは、`X-aws-proxy-auth`（認証トークン）と`X-aws-proxy-port`（転送先ポート）という2つの専用HTTPヘッダーで制御される。URLへのポート番号付与（`:8080`）は誤りであり、これがタイムアウトの原因と考えられる。

## エンドポイントの形式

`get-microvm`が返す`endpoint`はホスト名のみで、スキームやポートを含まない。クライアントは常にHTTPS（TLS）でこのホストにアクセスし、Lambda側がMicroVM内の指定ポートへ転送する。デフォルトの転送先はポート8080。対応プロトコルはHTTP/1.1、HTTP/2、WebSocket、gRPC、SSE。

## ポート指定はヘッダーで行う

転送先ポートの決定順位は以下の通り。

1. `X-aws-proxy-port`ヘッダー（通常のHTTPリクエスト）
2. WebSocketサブプロトコル`lambda-microvms.port.{N}`（カスタムヘッダーを設定できないWebSocketクライアント向け）
3. 未指定時はデフォルトの8080番ポート

`X-aws-proxy-*`はLambdaが予約したヘッダー名前空間であり、アプリケーションに転送される前に除去される。URLのホスト名やクエリパラメータにポートを含める方式ではない。

## 認証トークンの付与方法

すべてのリクエストに`X-aws-proxy-auth`ヘッダーで有効なトークンを付与する必要がある。`Authorization: Bearer`ではない。トークンは`create-microvm-auth-token`で発行するJWE（暗号化されたJSON Web Encryption）文字列で、対象MicroVM ID・許可ポート・有効期限がスコープとして埋め込まれる。

## `--allowed-ports`の意味

トークンがアクセスを許可するポートの範囲を指定する。`port`（単一ポート）、`range`（範囲）、`allPorts`（全ポート）のいずれか1つを指定するTagged Union構造。アプリが8080番でリッスンしているケースでは、`'[{"port":8080}]'`のように実際にアクセスしたいポートを指定する。リクエストの`X-aws-proxy-port`がトークンの`allowedPorts`に含まれない場合は403 Forbiddenとなる。

## `ALL_INGRESS`ネットワークコネクタ使用時の認証

`ALL_INGRESS`（ingress network connector）はあくまでMicroVMへの到達性（ネットワーク経路）を有効化するものであり、認証は免除されない。ingressコネクタの種類にかかわらず、`X-aws-proxy-auth`によるトークン認証は常に必須。

## エラーコードの対応

- 400 Bad Request: リクエスト形式不正、または`X-aws-proxy-port`ヘッダー・WebSocketサブプロトコルの形式が不正（ドキュメントの表現は"invalid port header"）。
- 403 Forbidden: トークン欠如・期限切れ・不正、または要求ポートが`allowedPorts`外。
- 502 Bad Gateway: アプリケーション未応答、またはauto-resumeが規定回数以内に成功しなかった場合。

## 正しいcurlコマンド例

```bash
# トークン発行（8080番ポートのみ許可、30分有効）
aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier <microvm-id> \
  --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]'

# 認証済みリクエスト（URLにポートを付けず、ヘッダーで指定する）
curl 'https://<microvm-endpoint>/' \
  -H 'X-aws-proxy-auth: <TOKEN>' \
  -H 'X-aws-proxy-port: 8080'
```

質問にあった`https://<endpoint>:8080/`という形式（URLへの直接的なポート付与）は仕様に存在せず、2分間応答なしでタイムアウトした挙動は、TLSエンドポイントとしては存在しないポート8080への直接接続を試みたことが原因である可能性が高い。`X-aws-proxy-port`ヘッダーに置き換えることで解消が見込める。

## 参考リンク

- [Networking - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Create your first Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html)
- [Security and permissions - AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
- [create-microvm-auth-token — AWS CLI Command Reference](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/create-microvm-auth-token.html)
- [AWS Lambda FAQs](https://aws.amazon.com/lambda/faqs/)
