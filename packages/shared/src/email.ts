/**
 * Thin wrapper around Resend's HTTP email API -- plain fetch, no vendor SDK
 * dependency, same "no marketplace SDK, just fetch" precedent every channel
 * connector in this codebase already follows (CLAUDE.md §4.3's own
 * ChannelConnector implementations). Confirmed against Resend's own current
 * API reference (POST https://api.resend.com/emails, Bearer auth, a plain
 * {from, to, subject, text} JSON body) -- not assumed from training data.
 *
 * This is an extraction, not a new capability: `packages/web/src/app/api/
 * leads/demo-request/route.ts` already sent a Resend email this exact way
 * (its own "New demo request" notification, RESEND_API_KEY already in
 * .env.example) before this module existed. It's pulled out here, into
 * packages/shared rather than left private to that one route, because the
 * channel-sync/HR alerting work below needs the identical
 * send-a-plain-text-email capability from packages/scheduler, which has no
 * reason to depend on packages/web. demo-request's own route now calls this
 * too, rather than keeping a second, duplicate copy of the same fetch call.
 *
 * Deliberately best-effort, never throws: every caller today sends this
 * AFTER the thing it's reporting is already durably recorded elsewhere (a
 * channel_connections status flip, a saved demo_requests row, a whole cron
 * job's own error already logged/captured to Sentry) -- a Resend outage, a
 * missing API key, or a network blip here must never become a reason the
 * calling job itself fails or a request 500s. Same "alerting machinery
 * failing is not itself an incident the caller should crash over" principle
 * observability.ts's flushObservability() doc comment already states for
 * Sentry.
 */

export interface SendEmailParams {
  /** One or more recipient addresses. A caller with zero recipients (e.g.
   *  a tenant with no users yet) should skip calling this entirely --
   *  sendEmail() also no-ops defensively on an empty array, logging why,
   *  rather than making a pointless Resend call. */
  to: string[];
  subject: string;
  /** Plain text only -- nothing in this codebase has needed HTML email yet;
   *  Resend accepts a text-only body fine. */
  text: string;
  /** Defaults to ALERT_FROM_EMAIL, then Resend's own sandbox sender -- see
   *  .env.example. Callers with their own distinct sender identity (e.g.
   *  demo-request's own DEMO_REQUEST_FROM_EMAIL) pass it explicitly. */
  from?: string;
}

/**
 * Sends a plain-text email via Resend. A no-op (returns false, no network
 * call) when RESEND_API_KEY isn't set in the environment -- same
 * "wire it now, verify against a real account later, inert until
 * configured" pattern as observability.ts's Sentry DSN, so every caller
 * below can call this unconditionally without first checking "is email
 * configured".
 *
 * Returns true only on a confirmed 2xx from Resend; every failure mode
 * (no API key, no recipients, a non-2xx response, a thrown network error)
 * is logged and swallowed, never thrown -- see this file's header comment
 * for why. Today's callers are all fire-and-forget and don't inspect the
 * return value, but it's there for a future caller that wants to know.
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return false;
  }
  if (params.to.length === 0) {
    console.warn("sendEmail: skipped, no recipients", { subject: params.subject });
    return false;
  }

  const from = params.from || process.env.ALERT_FROM_EMAIL || "AlltixOMS <onboarding@resend.dev>";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!response.ok) {
      console.error("sendEmail: Resend responded non-2xx", response.status, await response.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendEmail: Resend request threw", err);
    return false;
  }
}
