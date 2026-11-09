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
COPY --from=build /app/packages packages
COPY --from=build /app/apps apps
COPY --from=build /app/artifacts/apps artifacts/apps
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 8080

FROM runtime AS managed
CMD ["node", "artifacts/apps/managed/main.js"]

FROM runtime AS oss
CMD ["node", "artifacts/apps/oss/main.js"]
