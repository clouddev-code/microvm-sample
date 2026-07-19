# ベースイメージ: AWS Lambda MicroVMs用のAmazon Linux 2023ベースイメージ
# 要検証: public.ecr.aws/lambda/microvms:al2023-minimal がリージョン/アカウントから
# 参照可能か、また他に推奨タグがあるかは公式ドキュメントで確認してください。
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y python3.13 python3.13-pip && dnf clean all

WORKDIR /app
COPY requirements.txt .
RUN python3.13 -m pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 9000

CMD ["python3.13", "app.py"]
