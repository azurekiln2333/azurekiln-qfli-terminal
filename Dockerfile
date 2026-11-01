# Executor service image. It never builds or embeds a sandbox toolchain.
# The sandbox image is pulled separately into the dedicated rootless engine.
FROM docker:27-cli AS dockercli

FROM node:24.15.0-bookworm-slim

LABEL org.opencontainers.image.title="qfli-terminal-executor" \
      org.opencontainers.image.description="QFLI isolated terminal executor (rootless Docker client)"

# src/docker.js spawns the Docker CLI at this fixed path on host and container hosts.
COPY --from=dockercli /usr/local/bin/docker /usr/bin/docker

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src
COPY deployment/check-health.mjs deployment/verify-runtime.mjs deployment/smoke-isolation.py ./deployment/

# The container runs as UID 0 inside the dedicated rootless user namespace.
# src/config.js refuses to start unless UID 0 maps to the non-root host account.
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
    CMD ["node", "deployment/check-health.mjs"]

ENTRYPOINT ["node", "src/server.js"]
CMD []
