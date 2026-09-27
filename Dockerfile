# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies (toolchain in case better-sqlite3 has to compile) ---
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3005 \
    TZ=Europe/Berlin \
    DATABASE_PATH=/app/data/bahn-finder.db \
    DB_IMPERSONATE_PYTHON=/app/.venv/bin/python3
# Python for DB price requests (curl_cffi) and the punctuality import (duckdb).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir curl_cffi duckdb
RUN groupadd -r app && useradd -r -g app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json /app/next.config.mjs ./
RUN mkdir -p /app/data && chown app:app /app/data
USER app
EXPOSE 3005
CMD ["node_modules/.bin/next", "start", "-p", "3005"]
