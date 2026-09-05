import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @alltix/db, @alltix/shared, and @alltix/channel-connectors are workspace
  // packages published as plain .ts-compiled-to-.js -- transpile them
  // through Next's build instead of requiring them to ship their own
  // Next-compatible build.
  transpilePackages: ["@alltix/db", "@alltix/shared", "@alltix/channel-connectors"],
  // Deployment (Docker/self-hosted): traces only the files next start
  // actually needs into .next/standalone, so the image doesn't need the
  // full node_modules tree. outputFileTracingRoot must point at the
  // monorepo root, not this package -- by default Next's monorepo tracing
  // only looks inside packages/web (see Next's own `output` doc, "Caveats"),
  // which would miss the sibling workspace packages (@alltix/order-service
  // etc.) this app imports as prebuilt dist/ -- see the root-level `npm run
  // build` step those packages need before this one builds. Harmless on
  // Vercel, which ignores this in favor of its own packaging.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  output: "standalone",
};

export default nextConfig;
