# ParseFusion backend with a real OCR engine (Tesseract 5) baked in.
#   docker build -t parsefusion-backend .
#   docker run -p 8000:8000 -v pf_data:/data parsefusion-backend
# Check OCR: curl localhost:8000/health/agents  ->  "ocr": {"engine": "tesseract", "version": "5.x", ...}
FROM python:3.11-slim

ARG TESSERACT_LANGS="eng"
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr $(for l in $TESSERACT_LANGS; do echo tesseract-ocr-$l; done) \
      libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-backend.txt .
RUN pip install --no-cache-dir -r requirements-backend.txt

COPY backend ./backend
COPY common ./common
COPY src/agents ./src/agents

ENV PARSEFUSION_DATA_DIR=/data \
    TESSERACT_CMD=/usr/bin/tesseract \
    CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
