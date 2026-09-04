import { NextResponse, type NextRequest } from "next/server";
import { constructStripeWebhookEvent, handleStripeWebhookEvent } from "@alltix/billing-service";
import { getAppPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook: verifies the signature (mandatory per CLAUDE.md §6 --
 * "validate signatures on every inbound webhook ... don't trust unsigned
 * payloads," the same principle already applied to the Clerk webhook route
 * via svix) before touching the payload at all. The verified event is this
 * app's source of truth for subscription state, not anything the checkout
 * redirect or UI claims -- see handleStripeWebhookEvent in
 * @alltix/billing-service for what's persisted from which event.
 *
 * Raw body read via req.text(), same as the Clerk webhook route -- Stripe's
 * signature is computed over the exact raw bytes, so JSON-parsing first
 * (which can reorder/reformat) would make verification fail.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event;
  try {
    event = constructStripeWebhookEvent(rawBody, signature);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    await handleStripeWebhookEvent(getAppPool(), event);
  } catch (err) {
    // A genuine processing failure (DB error, etc.) -- non-2xx so Stripe's
    // built-in retry-with-backoff gets a chance to succeed later, unlike a
    // resolvable-tenant-not-found case (handleStripeWebhookEvent logs and
    // returns normally for that, since retrying a permanent mismatch would
    // never help).
    console.error(`Stripe webhook ${event.id} (${event.type}) processing failed:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
