FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY services/media-service/package.json services/media-service/package.json
COPY tsconfig.base.json tsconfig.base.json

RUN npm ci --workspaces --include-workspace-root

COPY services/media-service services/media-service

RUN npm run build -w @bin-ecommerce/media-service

FROM node:20-alpine AS production

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/media-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/media-service/package.json ./package.json

USER nodejs

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget --quiet --tries=1 --spider http://localhost:3010/api/health || exit 1

CMD ["node", "dist/main.js"]
