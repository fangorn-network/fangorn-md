# Single-stage: the server serves both /api and the built SPA on one port.
#
# The frontend is NOT built here. Run `pnpm build` on a dev machine and the
# resulting dist/ ships into the image. Bundling React+Privy+Slate needs ~2GB of
# RAM, which OOM-kills the build on small hosts (Raspberry Pi). dist/ is arch
# independent, so shipping it costs nothing and removes the heaviest step.
#
# Only production deps are installed. Browser-only packages (react, privy,
# slate-react, vite) live in devDependencies precisely so they stay out of here.
# The SDK version in package.json now matches what's installed, so a clean
# install is safe (it wasn't when this file copied host node_modules).
FROM node:22-slim
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY dist ./dist
COPY src ./src
COPY server ./server
COPY mcp ./mcp

ENV PORT=8787
EXPOSE 8787

# Secrets come from the environment at runtime (docker -e / compose env_file),
# never baked in. State lives in mounted volumes (docs/, .fangorn/).
CMD ["node", "server/index.js"]
