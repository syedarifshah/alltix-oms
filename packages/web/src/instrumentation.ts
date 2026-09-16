import * as Sentry from "@sentry/nextjs";

// CLAUDE.md §5/§11's observability gap, closed for the server/edge half of
// this app -- see instrumentation-client.ts for the browser half, and
// @alltix/shared's observability.ts for the plain-Node (non-Next) packages
// (scheduler, job scripts).
//
// This is the current (Next.js 16.3.3), non-deprecated way to initialize
// the Sentry Node/Edge SDKs -- confirmed by reading @sentry/nextjs's own
// installed build output directly (node_modules/@sentry/nextjs/build/cjs/
// config/webpack.js's warnAboutDeprecatedConfigFiles()), since WebFetch was
// unavailable this session (hit the session's request limit) to check
// Sentry's hosted docs. That function explicitly warns if it finds a
// sentry.server.config.ts/sentry.edge.config.ts file: "Please ensure to put
// this file's content into the register() function of a Next.js
// instrumentation file instead ... Sentry.init must be called inside of an
// instrumentation file." register() below is exactly that -- there is no
// separate sentry.server.config.ts/sentry.edge.config.ts in this repo, and
// there should not be one added later.
//
// register() runs once per server startup, in both the nodejs and edge
// runtimes (see Next's own instrumentation doc,
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md) --
// NEXT_RUNTIME distinguishes which, since Sentry's Node SDK isn't valid in
// the Edge runtime (and vice versa isn't necessary here since Edge only
// needs a lighter client).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      tracesSampleRate: 1.0,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      tracesSampleRate: 1.0,
    });
  }
}

// Reports errors from nested React Server Components / the server request
// pipeline that wouldn't otherwise surface as a caught exception anywhere
// this app's own code runs -- required export per Next.js's own
// instrumentation-file convention doc
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// instrumentation.md) and per @sentry/nextjs's own build-time check
// (warpAboutMissingOnRequestErrorHandler in the same webpack.js referenced
// above warns at build time if this hook is missing or doesn't reference
// onRequestError).
export const onRequestError = Sentry.captureRequestError;
