FROM python:3.11-slim

WORKDIR /app

# System deps kept minimal; wheels cover bcrypt/pymongo on slim.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render/other hosts inject $PORT; default to 8000 for local runs.
ENV PORT=8000
# Worker processes. Default 1 (safe on a 512MB free instance — 2+ workers there
# risk OOM). After upgrading the Render plan, set WEB_CONCURRENCY = number of
# vCPUs (e.g. 2–4) to use all cores; the code is multi-worker safe (race-safe
# seed + single-leader keepalive).
ENV WEB_CONCURRENCY=1
EXPOSE 8000

# --timeout-keep-alive / --backlog: hold many idle polling connections without stalling.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT} --workers ${WEB_CONCURRENCY:-1} --timeout-keep-alive 30 --backlog 2048"]
