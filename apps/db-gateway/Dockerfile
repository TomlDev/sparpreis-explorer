# Multi-arch (arm64 for Raspberry Pi + amd64). Build with buildx if needed.
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
EXPOSE 3009
CMD ["node", "server.mjs"]
