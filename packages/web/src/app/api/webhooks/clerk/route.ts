import { Webhook } from "svix";
import { NextResponse, type NextRequest } from "next/server";
import { provisionTenantForNewUser } from "@/lib/provision-tenant";

export const dynamic = "force-dynamic";

interface ClerkUserCreatedEvent {
  type: string;
  data: {
    id: string;
    email_addresses: { id: string; email_address: string }[];
    primary_email_address_id: string | null;
  };
}

/**
 * Clerk webhook: on `user.created`, provisions a new tenant for the user.
 * Signature verification (svix) is mandatory here per CLAUDE.md §6 --
 * "validate signatures on every inbound webhook ... don't trust unsigned
 * payloads." No admin/service-role DB bypass is used even here: provisioning
 * goes through the same app_user + RLS path as everything else (see
 * provision-tenant.ts).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("CLERK_WEBHOOK_SECRET is not set (see .env.example)");
  }

  const payload = await req.text();
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "missing svix headers" }, { status: 400 });
  }

  let event: ClerkUserCreatedEvent;
  try {
    event = new Webhook(secret).verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserCreatedEvent;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  if (event.type !== "user.created") {
    return NextResponse.json({ status: "ignored" });
  }

  const primaryEmail = event.data.email_addresses.find(
    (addr) => addr.id === event.data.primary_email_address_id,
  );
  const email = primaryEmail?.email_address ?? event.data.email_addresses[0]?.email_address;
  if (!email) {
    return NextResponse.json({ error: "user has no email address" }, { status: 400 });
  }

  const { tenantId } = await provisionTenantForNewUser({
    clerkUserId: event.data.id,
    email,
    tenantName: `${email}'s workspace`,
  });

  return NextResponse.json({ status: "provisioned", tenantId });
}
