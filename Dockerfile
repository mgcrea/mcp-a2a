# syntax=docker/dockerfile:1.7
#
# ⚠ This image runs the STDIO SERVER, not the daemon, and the two halves of this
#   server need to share one directory and one loopback port. A container gets
#   neither for free, so the two things a working `docker run` needs are:
#
#     --network host                            to reach the daemon on 127.0.0.1
#     -v ~/.local/state/mcp-a2a:/state \
#     -e A2A_STATE_DIR=/state                   to share the task store
#
#   The `-v` is the load-bearing one: without it the container holds its own
#   empty store and no task ever crosses. The daemon itself is better run on the
#   host under launchd — see scripts/install-launchagent.sh — because it has to
#   outlive every client, which is the whole reason it is a second process.
#
#   To run the daemon in the container instead, override the entrypoint:
#     docker run --network host -v ~/.local/state/mcp-a2a:/state \
#       -e A2A_STATE_DIR=/state -e A2A_TOKEN=... \
#       --entrypoint node mgcrea/mcp-a2a /app/dist/serve.js
#
# Build stage: install all deps, compile with tsdown, prune to prod-only deps.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
# Passed in from `pnpm docker:build` so the bundle bakes in real git info
# (the .git dir isn't COPY'd into the build context).
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT GIT_COMMIT_DATE=$GIT_COMMIT_DATE
RUN pnpm build && pnpm prune --prod

# Runtime stage: debian-slim with just node + prod node_modules + dist.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
