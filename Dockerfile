# Credster live server: the website, hosted seller nodes, the keeper and the faucet.
#   docker build -t credster .
#   docker run -p 8080:8080 -v credster-data:/data --env-file live.env -e TS_UPSTREAM_KEY=... credster
# State (node keys, receipts, reports) and NEAR keys live in the /data volume.
FROM node:22-slim
WORKDIR /app
COPY node/package.json node/package-lock.json node/
RUN cd node && npm ci --omit=dev --no-audit --no-fund
COPY node node
COPY web web
COPY scripts scripts
ENV NODE_ENV=production \
    PORT=8080 \
    CREDSTER_HOME=/data/credster \
    TS_CREDENTIALS=/data/near-credentials \
    TRUST_PROXY=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "node/src/cli.js", "live"]
