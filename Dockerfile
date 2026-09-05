# Builds and runs packages/web (the only deployable app in this monorepo)
# for a self-hosted/container target (AWS Fargate, etc.). Not needed for a
# Vercel deploy -- see vercel.json and DEPLOYMENT.md for that path instead.
#
# Two-stage build: the builder stage needs the full workspace (all
# packages' TypeScript source plus devDependencies) to run `npm run build`
# (tsc -b, which compiles every sibling package's dist/ that packages/web
# imports as a prebuilt dependency -- see next.config.mjs's comment) and
# then `next build`. The runtime stage only needs what Next's own
# `output: "standalone"` trace decided packages/web actually requires at
# runtime (see that next.config.mjs option) -- verified locally to come out
# to roughly 70MB, vs. 500+MB for the full workspace node_modules.

FROM node:22-alpine AS builder
WORKDIR /app

# Installed once, before copying source, so this layer is cached across
# builds that only change application code.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/inventory-service/package.json packages/inventory-service/
COPY packages/billing-service/package.json packages/billing-service/
COPY packages/order-service/package.json packages/order-service/
COPY packages/warehouse-service/package.json packages/warehouse-service/
COPY packages/rules-engine/package.json packages/rules-engine/
COPY packages/channel-connectors/package.json packages/channel-connectors/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/web/package.json packages/web/
RUN npm install

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages

# Builds every sibling package's dist/ (tsc -b), then packages/web itself.
# next build reads .env via the `dotenv -e` wrapper in packages/web's own
# build script -- pass build-time values as Docker build args/ARGs (or an
# .env baked into the build context) rather than real secrets in the image
# layer history; NEXT_PUBLIC_* values are the only ones that actually need
# to be present at build time (they're inlined into the client bundle).
RUN npm run build
RUN npm run build:web

# ---- runtime image ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/static ./packages/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "packages/web/server.js"]
