FROM oven/bun:1.3.11-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .

RUN chmod +x src/cli.ts && ln -sf /app/src/cli.ts /usr/local/bin/maw

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# NODE_NAME / PEER_URL / PEER_ALIAS are NOT baked here — they are federation
# *harness* config, set per-service in docker/compose.yml. Baking a default
# PEER_URL (node-b) made every standalone deploy (e.g. the review-plane) add a
# bogus peer → `maw serve` handshake failure → unhealthy. The entrypoint already
# defaults NODE_NAME to $(hostname) and skips `peers add` when PEER_URL is unset,
# so a peerless standalone container now boots clean.
ENV MAW_HOME=/root/.maw

EXPOSE 3456

HEALTHCHECK --interval=5s --retries=20 \
  CMD wget -qO- http://localhost:3456/api/plugins || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["maw", "serve", "3456"]
