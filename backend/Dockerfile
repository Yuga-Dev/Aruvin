# ============================================================================
# FILE: Dockerfile
# LOCATION: backend/Dockerfile
# PURPOSE: Build the NestJS backend image (build context = repository root).
# ROLE IN PROJECT: Keeps the checkout layout the runtime resolves from its
#   working directory: src/instructions/system.md and ../product_knowledge.md.
# KEY COMPONENTS: build stage (npm ci + nest build + prune), slim runtime stage.
# ============================================================================
# Debian, not Alpine: @livekit/rtc-node ships glibc prebuilt binaries.
FROM node:24-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./
COPY backend/src/instructions/system.md ./src/instructions/system.md
COPY product_knowledge.md /app/product_knowledge.md
USER node
# node is PID 1 so SIGTERM reaches Nest's shutdown/drain hooks directly.
CMD ["node", "dist/main.js"]
