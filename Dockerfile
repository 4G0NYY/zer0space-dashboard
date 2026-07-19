# python3/make/g++ are no longer installed: better-sqlite3 (the only native
# dependency) is gone from the runtime deps. 'pg' is pure JavaScript, so
# --omit=dev needs no build toolchain and the image gets noticeably smaller.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
LABEL org.opencontainers.image.source="https://github.com/zer0space-net/zer0space-dashboard" \
      org.opencontainers.image.description="zer0space homelab dashboard"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
