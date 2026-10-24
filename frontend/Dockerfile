FROM node:20-alpine@sha256:2a63a5947ffbaee54a75f2bd47cd0fff0fdb9d0dff5d21f1861facd88fe0d4a6 AS builder

WORKDIR /app

COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY frontend/ ./frontend/

RUN npm ci --workspace=frontend --include-workspace-root --ignore-scripts
WORKDIR /app/frontend
RUN npm run build

FROM node:20-alpine@sha256:2a63a5947ffbaee54a75f2bd47cd0fff0fdb9d0dff5d21f1861facd88fe0d4a6 AS runner

WORKDIR /app/frontend

ENV NODE_ENV=production
ENV PORT=5173

COPY --from=builder /app/frontend/package*.json ./
COPY --from=builder /app/frontend/dist ./dist

RUN npm ci --omit=dev --ignore-scripts && \
    addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app && \
    rm -rf /root/.npm /tmp/*

USER app

EXPOSE 5173

CMD ["sh", "-c", "npx vite preview --host 0.0.0.0 --port ${PORT:-5173}"]
