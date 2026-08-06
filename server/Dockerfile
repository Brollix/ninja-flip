# Cloud Run service "web": frontend (Vite) + API (Express) en un solo container.
# Build desde la RAIZ del repo: docker build -f server/Dockerfile -t web .

# ---- frontend ----
FROM node:22-slim AS frontend
WORKDIR /app
COPY app/package*.json ./
# chmod: algunas imágenes base de node recientes pierden el bit +x de los
# binarios en node_modules/.bin (tsc, vite) al instalarlos — sin esto,
# "npm run build" tira "Permission denied" aunque el paquete esté bien.
RUN npm ci && chmod -R a+rx node_modules/.bin
COPY app/ ./
RUN npm run build   # -> /app/dist

# ---- server ----
FROM node:22-slim AS server-build
WORKDIR /srv
COPY server/package*.json ./
RUN npm ci && chmod -R a+rx node_modules/.bin
COPY server/ ./
RUN npm run build   # -> /srv/dist

# ---- runtime ----
FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=server-build /srv/dist ./dist
COPY --from=frontend /app/dist ./public
EXPOSE 8080
CMD ["node", "dist/index.js"]
