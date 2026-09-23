import { NextResponse, type NextRequest } from "next/server";
import { sendEmail } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { checkIpRateLimit, getClientIp, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface DemoRequestBody {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  message?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public "Book a Demo" lead capture (src/app/(marketing)/book-a-demo).
 * Unauthenticated by design -- see src/proxy.ts's isPublicRoute, which must
 * include "/api/leads(.*)" or Clerk redirects a signed-out prospect to
 * sign-in before this ever runs. No tenant/Clerk-user context exists for an
 * anonymous visitor, so this writes through getAppPool() directly rather
 * than withTenant/withClerkUser -- see packages/db/migrations/0017_demo_requests.sql
 * for why that's safe (RLS is still enabled, just with an insert-only
 * policy, no SELECT grant for app_user).
 *
 * Rate limited by requester IP, not by tenant -- CLAUDE.md §16's own
 * "fourth pass" note named this as the one mutation route every other
 * rate-limiting pass left unprotected, since a signed-out visitor has no
 * `tenantId` for `api_rate_limit_windows` (migration 0033) to key a window
 * by at all. `checkIpRateLimit`/`getClientIp` (`@/lib/rate-limit`, migration
 * 0036_public_ip_rate_limit_windows.sql) close that the same structural way
 * every other rate-limited route in this app is checked: right after
 * resolving the caller (here, the caller's IP, the only identity a public
 * route has) and before any real work -- JSON-parsing the body included,
 * since a spam script's body is exactly the "real work" this exists to stop
 * before it reaches a DB write or a real outbound email. Returns a 429 with
 * a `Retry-After` header, not this app's usual redirect-with-`?error=` --
 * this is a JSON `fetch()` API (`BookDemoForm`'s own client component), not
 * a browser form POST, so there's no page to redirect back to, and a 429 +
 * `Retry-After` is the actually-correct HTTP shape for a JSON API a script
 * might be calling, unlike every other rate-limited route in this app.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();

  const clientIp = getClientIp(req.headers);
  const rateLimitError = await checkIpRateLimit(pool, clientIp, "leads.demo_request");
  if (rateLimitError) {
    return NextResponse.json(
      { error: RATE_LIMIT_ERROR_MESSAGE },
      { status: 429, headers: { "Retry-After": String(rateLimitError.retryAfterSeconds) } },
    );
  }

  let body: DemoRequestBody;
  try {
    body = (await req.json()) as DemoRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!name || name.length > 200) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }
  if (company.length > 200 || message.length > 4000) {
    return NextResponse.json({ error: "company or message is too long" }, { status: 400 });
  }

  await pool.query(
    "INSERT INTO demo_requests (name, email, company, message) VALUES ($1, $2, $3, $4)",
    [name, email, company || null, message || null],
  );

  await notifyDemoRequest({ name, email, company, message });

  return NextResponse.json({ status: "received" });
}

/**
 * Best-effort email notification via @alltix/shared's sendEmail() -- only
 * actually sends when both RESEND_API_KEY and DEMO_REQUEST_NOTIFY_EMAIL are
 * set (sendEmail() itself no-ops without the former; this function no-ops
 * without the latter, since there's nowhere to send it). The lead is
 * already durably saved in demo_requests by the time this runs, so a
 * failure here is inherently non-fatal to the request -- see sendEmail()'s
 * own doc comment for why it never throws.
 *
 * `from` falls back to sendEmail()'s own default chain when
 * DEMO_REQUEST_FROM_EMAIL isn't set (ALERT_FROM_EMAIL, then Resend's
 * sandbox sender) -- a harmless behavior change from this function's
 * pre-extraction version (which fell straight to the sandbox sender): both
 * are just "a domain verified in Resend" addresses, and sharing
 * ALERT_FROM_EMAIL as the one general fallback beats asking Arif to set two
 * near-identical env vars for the same purpose.
 */
async function notifyDemoRequest(lead: { name: string; email: string; company: string; message: string }): Promise<void> {
  const notifyEmail = process.env.DEMO_REQUEST_NOTIFY_EMAIL;
  if (!notifyEmail) {
    return;
  }

  await sendEmail({
    from: process.env.DEMO_REQUEST_FROM_EMAIL || undefined,
    to: [notifyEmail],
    subject: `New demo request: ${lead.name}${lead.company ? ` (${lead.company})` : ""}`,
    text: [
      `Name: ${lead.name}`,
      `Email: ${lead.email}`,
      `Company: ${lead.company || "—"}`,
      "",
      lead.message || "(no message)",
    ].join("\n"),
  });
}
