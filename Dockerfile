# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies (with build toolchain for better-sqlite3) ---
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# --- build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run db:generate || true
RUN npm run build

# --- runtime ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3005
ENV TZ=Europe/Berlin
RUN groupadd -r app && useradd -r -g app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3005
CMD ["node_modules/.bin/next", "start", "-p", "3005"]
