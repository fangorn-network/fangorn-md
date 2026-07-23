# Single-stage: the server serves both /api and the built SPA on one port.
#
# We COPY the host node_modules instead of running `pnpm install`. That is
# deliberate: the installed @fangorn-network/sdk (2026.07.14.0, the build with
# the crypto exports this app needs) does not match package.json/pnpm-lock, so a
# clean install would pull a different build and break encryption. No native
# modules are present, so copying across same-arch linux is safe. Once the SDK
# version/lockfile are reconciled, switch to a real `pnpm install --prod` build.
FROM node:22-slim
WORKDIR /app

COPY node_modules ./node_modules
COPY package.json vite.config.js index.html ./
COPY src ./src
COPY server ./server

# Build the frontend into dist/ (vite lives in the copied node_modules).
# VITE_* vars are inlined into the bundle at BUILD time, so the Privy app id
# must be present here — runtime env_file is too late for the browser. It's a
# public value (also shipped to the client), so baking it in is fine.
ARG VITE_PRIVY_APP_ID
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
RUN node_modules/.bin/vite build

ENV PORT=8787
EXPOSE 8787

# Secrets come from the environment at runtime (docker -e / compose env_file),
# never baked in. State lives in mounted volumes (docs/, .fangorn/).
CMD ["node", "server/index.js"]
