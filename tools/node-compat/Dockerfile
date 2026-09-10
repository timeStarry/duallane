ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools/node-compat/package.json tools/node-compat/package.json
RUN pnpm install --frozen-lockfile --prod --filter @duallane/node-compat-tools

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app/tools/node-compat
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/tools/node-compat/node_modules ./node_modules
COPY tools/node-compat/lib ./lib
COPY tools/node-compat/commands ./commands
COPY tools/node-compat/package.json tools/node-compat/storage-migrate.mjs tools/node-compat/storage-dedupe.mjs tools/node-compat/storage-provision.mjs ./
USER 65532:65532
# No daemon and no default storage operation. Operators select a one-shot CLI.
CMD ["node", "--help"]
