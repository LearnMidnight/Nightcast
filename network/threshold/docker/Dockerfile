# The Nightcast threshold-network operator. Built from the repository's top folder:
#   docker compose -f network/threshold/docker/compose.yml build
# (see docs/OPERATE.md). The proving keys aren't in the image: `nightcast-operator keys` downloads
# them into the data folder and checks them against the chain.

FROM node:22-bookworm AS build
# The Compact compiler, only to compile the oracle contract's JavaScript (no proving keys) that the
# shared tooling imports. The threshold contract comes compiled with the keys.
ARG COMPACT_TOOLCHAIN=0.31.1
RUN curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
ENV PATH=/root/.local/bin:$PATH
RUN compact update "$COMPACT_TOOLCHAIN"
WORKDIR /app
COPY . .
# npm ci also installs the dust wallet's fee options (postinstall).
RUN npm ci --no-audit --no-fund \
  && npm run compact:fast -w @nightcast/contract \
  && npm run build \
  && cd network && npm install --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
# Everything that is the operator's lives in /data: its folder (key, wallet, settings, the downloaded
# build), the wallet's saved state, and the wallet's own key cache.
ENV NIGHTCAST_OPERATOR_HOME=/data/operator \
    NIGHTCAST_STATE_DIR=/data/wallet-state \
    NIGHTCAST_KEY_CACHE=/data/cache/keys \
    NODE_ENV=production
VOLUME /data
ENTRYPOINT ["node", "/app/network/threshold/ops/nightcast-operator.mjs"]
CMD ["run"]
