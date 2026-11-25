# ============================================================================
# FILE: Dockerfile
# LOCATION: frontend/Dockerfile
# PURPOSE: Build the Vite SPA and serve it with nginx (build context = repo root).
# ROLE IN PROJECT: The nginx stage owns the network namespace the backend joins
#   and proxies /api to the loopback-bound backend; see deployment/docker/nginx.conf.
# KEY COMPONENTS: build stage (npm ci + vite build), nginx runtime stage.
# ============================================================================
FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Only browser setting allowed; never put credentials or identity in VITE_*.
ENV VITE_API_BASE=/api
RUN npm run build

FROM nginx:1.27-alpine
COPY deployment/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
