import { createAppPool } from "@alltix/db";
import type { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var -- module-scoped singleton, survives Next.js dev-server HMR reloads
  var __alltixAppPool: Pool | undefined;
  // eslint-disable-next-line no-var -- see getAdminPool()
  var __alltixAdminPool: Pool | undefined;
}

/**
 * Singleton `app_user` pool for this process. Every tenant-scoped query in
 * the web app goes through this pool via `withTenant`/`withClerkUser` from
 * @alltix/db -- never connect with a fresh Pool per request, and never use
 * DATABASE_URL (the schema-owning role) here, since RLS is not enforced for
 * table owners.
 */
export function getAppPool(): Pool {
  if (!globalThis.__alltixAppPool) {
    const connectionString = process.env.APP_DATABASE_URL;
    if (!connectionString) {
      throw new Error("APP_DATABASE_URL is not set (see .env.example)");
    }
    globalThis.__alltixAppPool = createAppPool({ connectionString });
  }
  return globalThis.__alltixAppPool;
}

/**
 * Singleton schema-owning (`DATABASE_URL`) pool -- the one deliberate
 * exception to "never use DATABASE_URL in application code" documented on
 * getAppPool() above and, at more length, on
 * packages/scheduler/src/index.ts's SyncAmazonOrdersParams.adminPool.
 * "Which tenants have an active Amazon connection" is inherently a
 * cross-tenant query RLS makes impossible through the normal app_user path
 * by design, and the only caller of this pool is
 * api/cron/amazon-order-sync/route.ts, which uses it for exactly that one
 * enumeration query and nothing else -- every subsequent per-tenant
 * operation still goes through getAppPool() via withTenant(), scoped
 * exactly like the rest of the app. Do not reach for this pool anywhere
 * else.
 */
export function getAdminPool(): Pool {
  if (!globalThis.__alltixAdminPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    globalThis.__alltixAdminPool = createAppPool({ connectionString });
  }
  return globalThis.__alltixAdminPool;
}
