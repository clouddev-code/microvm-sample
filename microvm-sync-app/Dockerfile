# ベースイメージ: AWS Lambda MicroVMs用のAmazon Linux 2023ベースイメージ
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# AWS Lambda MicroVMsのイメージビルド環境はghcr.io（COPY --from=ghcr.io/astral-sh/uv:latest等）に
# 到達できずビルドがハングする（実機で確認済み。microvm-worker同様pip経由のPyPIアクセスは
# 疎通実績があるため、uv本体もpip経由でインストールする）。
RUN dnf install -y python3.13 python3.13-pip && dnf clean all
RUN python3.13 -m pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --python python3.13

COPY app.py .

EXPOSE 9000
EXPOSE 8080

CMD ["uv", "run", "--no-sync", "python3.13", "app.py"]
