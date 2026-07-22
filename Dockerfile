# syntax=docker/dockerfile:1

# Alpine works here because every runtime dependency ships a musllinux wheel
# (see requirements.txt). No compiler is installed and none is needed — if a
# dependency bump ever breaks that, switch this line to python:3.12-slim instead
# of adding gcc/musl-dev, which would put a build toolchain in the runtime image.
FROM python:3.12-alpine

LABEL org.opencontainers.image.source="https://github.com/zer0space-net/zer0space-dashboard" \
      org.opencontainers.image.description="zer0space homelab dashboard"

# PYTHONDONTWRITEBYTECODE: the container filesystem is throwaway, so .pyc files
# are pure noise. PYTHONUNBUFFERED: without it print() output sits in a buffer
# and `docker service logs` shows nothing until the process exits — which is
# exactly when you need the logs most.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies before source: this layer stays cached across every commit that
# does not touch requirements.txt, which is nearly all of them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY static/ ./static/
COPY templates/ ./templates/

# The app never writes to its own filesystem — uploads and backup drops live on
# the /data volume — so it runs unprivileged.
RUN adduser -D -H -u 10001 zer0space
USER 10001

EXPOSE 3000

# Liveness only, deliberately not touching PostgreSQL: a health check that
# failed during a database outage would have Swarm restart a container that is
# behaving exactly as designed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=4).status == 200 else 1)"

# One worker, not several. The session store is in-process memory and holds the
# per-user vault key (see src/auth.py), so a second worker would serve requests
# that cannot see the session the first one created.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
