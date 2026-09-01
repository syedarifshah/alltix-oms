import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface ChannelConnectionRow {
  external_account_id: string;
  marketplace: string;
  status: string;
  created_at: string;
}

interface ChannelsSettingsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

/**
 * Shows whether Amazon is connected for the signed-in tenant, with a
 * "Connect Amazon" link to /api/channels/amazon/connect when it isn't.
 * Auth/tenant resolution mirrors src/app/orders/page.tsx exactly -- see that
 * file's comment for why this goes through getAuthContext/resolveTenantId
 * instead of calling Clerk's auth() directly.
 */
export default async function ChannelsSettingsPage({
  searchParams,
}: ChannelsSettingsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { connected, error } = await searchParams;

  if (!tenantId) {
    return (
      <main>
        <h1>Channels</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const connection = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<ChannelConnectionRow>(
      `SELECT external_account_id, marketplace, status, created_at
         FROM channel_connections
        WHERE channel = 'amazon'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    return result.rows[0] ?? null;
  });

  const isConnected = connection?.status === "active";

  return (
    <main>
      <h1>Channels</h1>
      {connected === "amazon" && <p>Amazon connected.</p>}
      {error && <p>Amazon connection failed ({error}).</p>}

      <h2>Amazon</h2>
      {isConnected ? (
        <p>
          Connected — seller {connection.external_account_id} ({connection.marketplace}), since{" "}
          {new Date(connection.created_at).toISOString()}
        </p>
      ) : (
        <>
          {connection && <p>Status: {connection.status}</p>}
          <a href="/api/channels/amazon/connect">Connect Amazon</a>
        </>
      )}
    </main>
  );
}
