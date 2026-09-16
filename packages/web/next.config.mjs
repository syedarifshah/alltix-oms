import { fileURLToPath } from "node:url";
import path from "node:path";
// Imported from the "/config" subpath, not the package root -- confirmed by
// a real `next build` warning ("Importing withSentryConfig from
// @sentry/nextjs is deprecated and will stop working in v11. Import it from
// @sentry/nextjs/config instead") on the very first build against this
// installed version (10.74.0). Heeded immediately per this package's own
// AGENTS.md ("Heed deprecation notices").
import { withSentryConfig } from "@sentry/nextjs/config";

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

// Wraps the config to enable source-map upload (build time, no-ops without
// SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT set -- see .env.example) and
// the Turbopack/Webpack value-injection rules instrumentation.ts and
// instrumentation-client.ts need at build time. Confirmed by reading
// @sentry/nextjs's own installed source (node_modules/@sentry/nextjs/build/
// cjs/config/turbopack/generateValueInjectionRules.js) that this wrapper's
// Turbopack path is a real, current, non-webpack-only code path -- not the
// stale "Sentry + Turbopack don't mix yet" caveat from older training data.
// org/project/authToken are left unset here deliberately (same "wire it
// now, verify later" call as every marketplace credential in this repo) --
// they read from SENTRY_ORG/SENTRY_PROJECT/SENTRY_AUTH_TOKEN automatically
// when those env vars exist, and source-map upload just silently skips
// itself without them (confirmed via the same source read -- these three
// options are optional, not required for the app itself to build or run).
export default withSentryConfig(nextConfig, {
  silent: true,
  widenClientFileUpload: true,
});
