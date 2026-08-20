# Bit flipping HTTPS proxy in front of the live stream, see proxy.py.
FROM python:3.12-slim

RUN pip install --no-cache-dir "aiohttp>=3.9,<4"

WORKDIR /app
COPY proxy.py /app/proxy.py

EXPOSE 443
CMD ["python", "-u", "/app/proxy.py"]
