import { randomUUID } from "node:crypto";
import { withTenantAndUser } from "@alltix/db";
import { getAppPool } from "./db";

/**
 * First-time provisioning for a newly signed-up Clerk user: creates a brand
 * new tenant owned by that user and links them via `users`. MVP model is one
 * tenant per signup (invite-a-teammate-into-an-existing-tenant is a v2
 * feature) -- see CLAUDE.md §0 locked scope.
 *
 * The tenant id is minted client-side (not DB-generated) so it can be passed
 * into withTenantAndUser and satisfy both rows' RLS WITH CHECK clauses in
 * the same transaction: this is the one place app code is allowed to "act
 * as" a tenant it's simultaneously creating.
 */
export async function provisionTenantForNewUser(params: {
  clerkUserId: string;
  email: string;
  tenantName: string;
}): Promise<{ tenantId: string }> {
  const tenantId = randomUUID();
  const pool = getAppPool();

  await withTenantAndUser(pool, { tenantId, clerkUserId: params.clerkUserId }, async (client) => {
    await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, params.tenantName]);
    await client.query(
      "INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)",
      [tenantId, params.clerkUserId, params.email],
    );
  });

  return { tenantId };
}
