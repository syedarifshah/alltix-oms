# Deployment Guide

Everything in this file was verified by actually running it in the review/implementation
session that wrote it (see the git log around this commit) — the production build, the
standalone server, the full CI recipe against a from-scratch database were all run for
real, not assumed. The two things that were **not** verified: the Docker image itself
(no Docker daemon was available in that sandbox — every individual step the Dockerfile
runs was verified outside Docker instead), and anything requiring real outbound network
access to Amazon (blocked in that sandbox; see the note in §5).

## 1. What "deployment-ready" means today

This adds the pieces that didn't exist before: a CI pipeline (`.github/workflows/ci.yml`),
a production build path for both Vercel and a container host (`vercel.json`, `Dockerfile`),
and this checklist. It does **not** resolve the two decisions only Arif can make:
Amazon production access (§5) and when Stripe moves out of test mode (§4). Both are
called out below rather than papered over.

## 2. Hosting: Vercel (recommended path)

Vercel is the path of least setup for a Next.js app and is what this guide assumes.
`Dockerfile` exists as the alternative (§7) if AWS Fargate is preferred instead, matching
CLAUDE.md §5's original infra column — nothing here forces that choice, it's just not
the default path documented step-by-step.

**Import the project**: from the Vercel dashboard, "Add New" → "Project" → import
`syedarifshah/alltix-oms`.

**Leave Root Directory as the repository root — do not set it to `packages/web`.**
This is the one setting that will silently break the build if changed: `packages/web`
depends on five sibling workspace packages (`@alltix/order-service`,
`@alltix/warehouse-service`, `@alltix/rules-engine`, `@alltix/inventory-service`,
`@alltix/billing-service`) as prebuilt `dist/` output, not source — only
`@alltix/db`, `@alltix/shared`, and `@alltix/channel-connectors` are transpiled from
source directly (see `packages/web/next.config.mjs`'s comment). Building those five
packages first needs `npm run build` (`tsc -b`) to run at the monorepo root before
`next build` runs — and Vercel's own docs state that with Root Directory set to a
subdirectory, "your app will not be able to access files outside of that directory,"
which would make that first build step impossible. `vercel.json` (already committed)
handles this correctly *because* Root Directory stays at the repo root:

```json
{
  "framework": "nextjs",
  "installCommand": "npm install",
  "buildCommand": "npm run build && npm run build:web",
  "outputDirectory": "packages/web/.next"
}
```

**Environment variables** — set these in the Vercel project's Settings → Environment
Variables (Production environment). Every name below is documented in `.env.example`
with a comment on where it comes from:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Managed Postgres, schema-owning role (§3) |
| `APP_USER_PASSWORD`, `APP_DATABASE_URL` | Managed Postgres, least-privilege role (§3) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Clerk dashboard, **production** instance (already decided — see §6) |
| `CHANNEL_CREDENTIALS_ENCRYPTION_KEY` | `openssl rand -base64 32` — generate fresh for production, never reuse a dev value |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MVP_PRICE_ID` | Stripe dashboard — **test mode**, deliberately (§4) |
| `AMAZON_PRODUCTION_*` | Still blocked (§5) — leave unset until resolved |
| `ALLTIX_TEST_AUTH_BYPASS` | **Do not set this in Vercel at all.** It's a dev-only escape hatch; `next build`/`next start` force `NODE_ENV=production` regardless, so it's structurally inert even if set by mistake — but there's no reason to set it. |

After the first successful deploy, run the migration step once against the production
database (§3) before visiting the site — there are no tables yet otherwise.

## 3. Database: managed Postgres

Any managed Postgres 16 works; this wasn't tested against a specific provider, only
against local Postgres 16. Two reasonable options: **Neon** (serverless, generous free
tier, pairs naturally with Vercel's per-request model) or a provider you already use.
Either way:

1. Create the database and note its connection string as `DATABASE_URL` — this is the
   schema-owning role migrations run as.
2. Run `DATABASE_URL=<production-url> APP_USER_PASSWORD=<a-strong-password> npm run db:migrate`
   once, from a machine that can reach the production database (locally, or a one-off
   CI job). This applies all 16 migrations and creates the `app_user` role migration
   0001 owns (see that file — it's idempotent, safe to re-run).
3. Set `APP_DATABASE_URL` to `postgres://app_user:<that-password>@<host>/<db>` — this
   is the RLS-enforced role every request actually queries as. **Never** point the
   running app at `DATABASE_URL` directly — Postgres does not apply row-level security
   to a table's owning role, which is the entire tenant-isolation guarantee this system
   relies on.

## 4. Billing: staying in Stripe test mode is deliberate, not a gap

Per your answer earlier in this project (Clerk production, Stripe test) and
`.env.example`'s own comment on `STRIPE_SECRET_KEY`: *"There is exactly one tenant
self-testing this right now, not a paying customer — no reason to ever put a live-mode
key here."* That reasoning doesn't change just because the app is now deployed
somewhere real — deploying to production infrastructure and taking real payments are
separate decisions. Use `sk_test_...`/`whsec_...`/a test-mode `price_...` (via
`npm run stripe:setup-mvp-plan`) in the production environment for now; switch to
live-mode keys only once there's an actual paying customer to onboard, which is a
deliberate switch-the-three-env-vars moment, not a deploy-time decision.

## 5. Amazon: production access is still the open item (deliberately skipped here)

Per this conversation's own explicit instruction, this pass does not attempt to resolve
the Amazon production OAuth/self-authorization question — that's still exactly where
earlier discussion in this project left it. Concretely, before this app can do anything
with a real seller's Amazon data: `AMAZON_PRODUCTION_CLIENT_ID/_SECRET/_REFRESH_TOKEN/_SELLER_ID/_MARKETPLACE_ID`
need real values (obtained however that question gets resolved), and until then,
`/settings/channels`'s "Connect Amazon" flow and every `AMAZON_PRODUCTION_*` env var
stay unset in the production environment. The app deploys and runs correctly without
them — Amazon just won't be connectable for a real seller until this is sorted.

## 6. Clerk: production instance

A production Clerk instance was confirmed to already exist (per this conversation).
Wire its publishable/secret keys and webhook signing secret into the environment
variables in §2. One thing worth double-checking before the first real signup: the
Clerk webhook endpoint (`/api/webhooks/clerk`, which provisions a tenant the moment
someone signs up — see `packages/web/src/lib/provision-tenant.ts`) needs to be
registered in the production Clerk instance's dashboard pointing at the production
domain, separately from whatever was configured for local/test use.

## 7. Alternative: container deployment (`Dockerfile`)

For AWS Fargate or any other container host instead of Vercel. `Dockerfile` builds a
two-stage image: the builder stage runs the same `npm run build && npm run build:web`
sequence as Vercel, and the runtime stage copies only what Next's `output: "standalone"`
trace decided is actually needed (verified locally at ~70MB, vs. 500+MB for the full
workspace `node_modules` — see `next.config.mjs`'s `outputFileTracingRoot` comment for
why the monorepo-wide root had to be set explicitly for that trace to find the sibling
packages' `dist/` output).

**Not verified**: the Docker image was not actually built or run in the session that
wrote this — the sandbox's Docker daemon couldn't start there (a container-nesting
restriction, not a project issue). Every step the Dockerfile runs was independently
verified working outside Docker: `npm install`, `npm run build`, `npm run build:web`,
and the resulting `.next/standalone/packages/web/server.js` were all run for real and
confirmed to serve `/api/health` with `200 {"status":"ok"}`. Build the image once
yourself (`docker build -t alltix-oms .` from the repo root) and smoke-test it
(`docker run -p 3000:3000 --env-file .env.production alltix-oms`) before trusting it
in a real Fargate task definition — it should work, but "should" isn't "confirmed" for
the image itself.

Whichever host runs the container, all of §2's environment variables still apply, and
the migration step in §3 is still a one-time manual step, not something the container's
startup does automatically.

## 8. CI (`.github/workflows/ci.yml`)

Runs on every push/PR to `main`: typecheck, build every workspace package, production
`next build`, apply migrations against a fresh Postgres service container, then run the
full non-Amazon-sandbox test suite (`npm test` — see `scripts/run-tests.sh` for exactly
which 12 test files that is and why the other 4 are excluded). This whole sequence was
run by hand against a from-scratch database before being committed, so it isn't a
config that merely looks plausible.

**Deliberately does not auto-deploy.** CI catches breakage; shipping to production
stays a deliberate action you (or Vercel's own GitHub integration, if you connect it)
trigger, not something that happens automatically on every merge — appropriate while
Amazon production access and the Stripe test-to-live switch are both still open.
Vercel's GitHub integration, once connected, will deploy previews on every PR and
production on every merge to `main` independently of this workflow; if that's more
automation than you want yet, deploy manually via the Vercel dashboard/CLI instead of
connecting that integration.

**Never add Amazon sandbox credentials to CI secrets.** `npm run test:amazon-sandbox`
(the 4 tests requiring `AMAZON_SANDBOX_*` and real network access to Amazon) is meant
to be run locally, on a machine that can actually reach Amazon's endpoints — a
standard hosted GitHub Actions runner's egress isn't guaranteed to reach them either,
so this isn't only a secrets-hygiene call.

## 9. Post-deploy smoke test

After the first deploy, before calling it done:

1. `GET /api/health` returns `200 {"status":"ok"}`.
2. Sign up a real (throwaway) account through Clerk — confirms the production webhook
   is wired correctly and a tenant actually gets provisioned (§6).
3. Visit `/orders`, `/inventory`, `/picklists`, `/rules` signed in as that account —
   each should render empty-but-functional (no data yet, no errors).
4. Visit `/settings/billing` — confirms `getOrCreateStripeCustomer` succeeds against
   the test-mode Stripe keys (§4).
5. Visit `/settings/channels` — confirms it renders "Connect Amazon" without erroring,
   even though clicking it won't succeed yet (§5).

None of this was run against an actual production deployment as part of writing this
guide — there is no production deployment yet. This is the checklist for when there is
one.
