import { Pool, type PoolClient } from "pg";

export interface CreatePoolOptions {
  connectionString: string;
}

/** Pool for the least-privilege `app_user` role. Every tenant-scoped query
 * must run through {@link withTenant} so the RLS session variable is set. */
export function createAppPool(options: CreatePoolOptions): Pool {
  return new Pool({ connectionString: options.connectionString });
}

/**
 * Runs `fn` inside a transaction with `app.tenant_id` set for the duration of
 * that transaction only (`set_config(..., true)` mirrors `SET LOCAL`), so
 * every row-level-security policy defined in packages/db/migrations scopes
 * queries to `tenantId`. Never reuse a client outside this wrapper for
 * tenant-scoped tables — RLS is not enforced without the session variable.
 *
 * A bound parameter is used for the tenant id (via `set_config`) rather than
 * string-interpolating it into `SET LOCAL app.tenant_id = '...'`, since SET
 * does not accept query parameters and interpolation would risk injection.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction with `app.clerk_user_id` set (SET LOCAL
 * semantics, same as {@link withTenant}) but `app.tenant_id` left unset.
 * This is only for the pre-tenant-resolution step: looking up a signed-in
 * Clerk user's row in `users` to find their tenant_id, before that tenant_id
 * is known. Any tenant-scoped table other than `users` is invisible during
 * this call, by design -- switch to {@link withTenant} once tenant_id is
 * resolved, don't keep using this for anything else in the request.
 */
export async function withClerkUser<T>(
  pool: Pool,
  clerkUserId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clerk_user_id', $1, true)", [clerkUserId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` with both `app.tenant_id` and `app.clerk_user_id` set for the
 * transaction. Only for first-time provisioning: creating a brand new
 * tenant row and its owning user row in the same transaction, where the
 * caller mints `tenantId` up front (e.g. `crypto.randomUUID()`) so both
 * inserts satisfy their RLS WITH CHECK clauses. Not for ordinary request
 * handling -- use {@link withTenant} once a user's tenant already exists.
 */
export async function withTenantAndUser<T>(
  pool: Pool,
  ids: { tenantId: string; clerkUserId: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantId]);
    await client.query("SELECT set_config('app.clerk_user_id', $1, true)", [ids.clerkUserId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
