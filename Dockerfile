FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MCP_OAUTH_STORE_PATH=/data/oauth-store.json \
    MCP_USERS_DIR=/data/users

WORKDIR /app

RUN mkdir -p /data/users && chown -R node:node /data /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && chown -R node:node /app

COPY --chown=node:node dist ./dist
COPY --chown=node:node README.md ./

USER node
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "dist/index.js", "--http"]
