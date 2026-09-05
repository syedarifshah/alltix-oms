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
  // outputFileTracingRoot must point at the monorepo root, not this package
  // -- by default Next's monorepo tracing only looks inside packages/web
  // (see Next's own `output` doc, "Caveats"), which would miss the sibling
  // workspace packages (@alltix/order-service etc.) this app imports as
  // prebuilt dist/ -- see the root-level `npm run build` step those
  // packages need before this one builds. This applies regardless of
  // output mode, so it's set unconditionally below.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Deployment (Docker/self-hosted only): traces only the files next start
  // actually needs into .next/standalone, so the image doesn't need the
  // full node_modules tree.
  //
  // Must NOT be set when building on Vercel. Confirmed by an actual failed
  // Vercel deploy: with `output: "standalone"` present, `next build` itself
  // succeeds (compiles, typechecks, generates pages) but Vercel's own
  // post-build packaging step ("Running onBuildComplete from Vercel") then
  // fails with `ENOENT: .../packages/web/.next/next-server.js.nft.json`.
  // Vercel has its own output-tracing/packaging pipeline (it's a "Verified
  // Adapter", not a generic Node host) and does not expect `output:
  // "standalone"` to also be set -- see Next.js GitHub issue #43654
  // ("Standalone server does not work with `vercel build` output") for the
  // same conflict reported by others. `VERCEL` is a platform-provided env
  // var set on every Vercel build (and only there), so this keeps
  // standalone mode for the Docker/self-hosted path while skipping it on
  // Vercel, which packages the app its own way regardless.
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
};

export default nextConfig;
