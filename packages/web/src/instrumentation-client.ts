import * as Sentry from "@sentry/nextjs";

// The browser half of this app's Sentry wiring -- see instrumentation.ts
// for the server/edge half and that file's header comment for how this was
// confirmed against the actually-installed @sentry/nextjs (10.74.0)/
// Next.js (16.3.3) versions rather than assumed from training data.
//
// instrumentation-client.ts (this exact filename, at src/ or the project
// root) is a Next.js file convention introduced in v15.3 -- confirmed by
// reading node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation-client.md directly, per this
// package's own AGENTS.md instruction to check node_modules/next/dist/docs
// before writing anything Next-version-sensitive. Next loads this file on
// the client automatically (no import/registration needed) after the page
// starts loading but before the app's own JS runs.
//
// IMPORTANT: this repo builds with Turbopack (`next build` prints
// "(Turbopack)" -- confirmed via a real build output), and this file is
// the ONLY supported place for client-side Sentry.init() under Turbopack.
// The older sentry.client.config.ts convention still works under Webpack
// but is explicitly called out as broken under Turbopack by @sentry/nextjs
// itself: node_modules/@sentry/nextjs/build/cjs/config/webpack.js's
// getClientSentryConfigFile()/its call site logs "When using Turbopack
// `sentry.client.config.ts` will no longer work" if it finds one. Do not
// add a sentry.client.config.ts alongside this file.
//
// NEXT_PUBLIC_ prefix is required (standard Next.js behavior, unrelated to
// the version-specific changes above) -- only NEXT_PUBLIC_-prefixed env
// vars are inlined into the browser bundle; a bare SENTRY_DSN here would
// always read as undefined client-side.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
});

// Required export, confirmed by a real `next build` warning ("ACTION
// REQUIRED: To instrument navigations, the Sentry SDK requires you to
// export an onRouterTransitionStart hook from your
// instrumentation-client.(js|ts) file") on the first build against this
// installed @sentry/nextjs version (10.74.0) -- also documented as an
// experimental Next.js 16.3+ hook in this exact file's own convention doc
// (node_modules/next/dist/docs/.../instrumentation-client.md). Without
// this, page navigations aren't captured as Sentry transactions/breadcrumbs
// (errors still are).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
