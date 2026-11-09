FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts
COPY deploy deploy
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/protocol/fixtures packages/protocol/fixtures
COPY --from=build /app/packages/server-core/package.json packages/server-core/package.json
COPY --from=build /app/packages/server-core/dist packages/server-core/dist
COPY --from=build /app/packages/server-core/migrations packages/server-core/migrations
COPY --from=build /app/artifacts/apps artifacts/apps
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
RUN rm -rf packages/server-core/dist/testing && mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 8080

FROM runtime AS managed
CMD ["node", "artifacts/apps/managed/main.js"]

FROM runtime AS oss
CMD ["node", "artifacts/apps/oss/main.js"]
