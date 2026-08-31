import { createAppPool } from "@alltix/db";
import type { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var -- module-scoped singleton, survives Next.js dev-server HMR reloads
  var __alltixAppPool: Pool | undefined;
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
