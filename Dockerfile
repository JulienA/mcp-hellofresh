FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    HELLOFRESH_SESSION_PATH=/data/session.json \
    MCP_OAUTH_STORE_PATH=/data/oauth-store.json

WORKDIR /app

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R pwuser:pwuser /app

COPY --chown=pwuser:pwuser dist ./dist
COPY --chown=pwuser:pwuser README.md ./

USER pwuser
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "dist/index.js", "--http"]
