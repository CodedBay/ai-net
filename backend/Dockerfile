FROM node:20-alpine@sha256:2a63a5947ffbaee54a75f2bd47cd0fff0fdb9d0dff5d21f1861facd88fe0d4a6 AS builder

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY tsconfig.json ./
COPY backend/ ./backend/

RUN npm ci --workspace=backend --include-workspace-root --ignore-scripts
WORKDIR /app/backend
RUN npm run build

FROM node:20-alpine@sha256:2a63a5947ffbaee54a75f2bd47cd0fff0fdb9d0dff5d21f1861facd88fe0d4a6 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/backend/package*.json ./backend/
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/src/db/migrations ./backend/src/db/migrations
COPY --from=builder /app/backend/scripts ./backend/scripts

RUN npm ci --prefix ./backend --omit=dev --ignore-scripts && \
    addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app && \
    rm -rf /root/.npm /tmp/*

USER app
WORKDIR /app/backend

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
