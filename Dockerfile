# Media Service dùng build context là root repository để tsconfig.json có thể
# resolve tsconfig.base.json của monorepo. Lambda processor không được copy vào
# image HTTP vì chúng có Dockerfile và lifecycle triển khai riêng.

# -----------------------------------------------------------------------------
# Giai đoạn build: cài dependency theo lockfile riêng của Media và compile HTTP API.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Media có package-lock riêng vì package này còn phục vụ các Lambda processor.
# Copy manifest trước source để thay đổi code không làm mất cache npm layer.
COPY services/media-service/package.json services/media-service/package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY services/media-service/tsconfig.json ./services/media-service/tsconfig.json
COPY packages/common ./packages/common

# Cài cả dev dependency để có TypeScript trong lúc build, nhưng không chạy
# lifecycle script tự động từ package bên ngoài.
RUN npm ci --include=dev --ignore-scripts

# Chỉ copy source HTTP; lambda/, scripts/ và docs không thuộc runtime này.
COPY services/media-service/src ./services/media-service/src

# tsconfig.json của Media dùng rootDir monorepo nên output nằm trong thư mục
# dist/services/media-service/src và được thu gọn ở production stage.
RUN npx tsc -p services/media-service/tsconfig.json

# Sau khi compile, loại Nest CLI, TypeScript, Jest và các dev dependency khác.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Giai đoạn runtime: image nhỏ, non-root, chỉ chứa HTTP artifact và dependency cần thiết.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Update Alpine packages so the runtime receives current security fixes.
RUN apk upgrade --no-cache

# npm/npx chỉ cần ở builder để cài dependency; runtime chỉ chạy bằng node.
# Loại chúng khỏi final image để không mang theo dependency/tooling không cần thiết của npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nestjs -u 1001

WORKDIR /app

COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/services/media-service/dist/services/media-service/src ./dist
COPY --from=builder --chown=nestjs:nodejs /app/services/media-service/dist/packages/common ./dist/packages/common

# Port thật của Media Service là 3004; có thể override bằng Compose/Kubernetes.
ENV NODE_ENV=production \
  PORT=3004 \
  NODE_OPTIONS=--max-old-space-size=128

EXPOSE 3004

# Liveness chỉ kiểm tra process HTTP; readiness mới kiểm tra cấu hình và S3.
# Dùng ${PORT} để healthcheck khớp khi runtime được override port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://localhost:${PORT}/api/v1/health/live" || exit 1

USER nestjs

# Chạy Node trực tiếp để nhận SIGTERM đúng trong Docker/Kubernetes rollout.
CMD ["node", "dist/main.js"]
