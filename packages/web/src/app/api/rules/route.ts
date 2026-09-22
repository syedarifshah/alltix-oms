import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { recordAuditEvent } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

/** Parses one of the two JSON-array textareas on the /rules "New rule" form.
 *  Throws a message suitable for display (via redirectWithError) rather
 *  than a raw JSON.parse/TypeError -- this route has no client-side
 *  validation to catch a malformed body first. */
function parseJsonArray(raw: FormDataEntryValue | null, fieldName: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? "[]"));
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON array.`);
  }
  return parsed;
}

/** POST /api/rules -- creates one automation_rules row from the /rules page's
 *  "New rule" form. Conditions/actions are stored as raw JSON (this pass's
 *  documented scope call -- no visual rule builder yet); the only
 *  validation here is "is this actually a JSON array," not that its
 *  contents are semantically sound (RulesEngine already fails closed on an
 *  unrecognized condition op or action type at evaluation time). */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/rules", "not signed in");
  }

  const formData = await req.formData();
  const name = String(formData.get("name") ?? "").trim();
  const triggerEvent = String(formData.get("triggerEvent") ?? "").trim();
  const priority = Number(formData.get("priority"));
  const enabled = formData.get("enabled") === "on";

  if (!name || !triggerEvent) {
    return redirectWithError(req, "/rules", "Name and trigger event are required.");
  }
  if (!Number.isInteger(priority)) {
    return redirectWithError(req, "/rules", "Priority must be a whole number.");
  }

  let conditions: unknown[];
  let actions: unknown[];
  try {
    conditions = parseJsonArray(formData.get("conditions"), "Conditions");
    actions = parseJsonArray(formData.get("actions"), "Actions");
  } catch (err) {
    return redirectWithError(req, "/rules", errorMessage(err));
  }

  try {
    await withTenant(getAppPool(), user.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [user.tenantId, name, triggerEvent, JSON.stringify(conditions), JSON.stringify(actions), priority, enabled],
      );
      // Same transaction as the INSERT above -- see recordAuditEvent's own
      // doc comment for why that matters (a rolled-back rule create never
      // leaves a committed audit row behind).
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "rule.created",
        entityType: "automation_rule",
        entityId: result.rows[0]!.id,
        details: { name, triggerEvent, priority, enabled },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/rules", errorMessage(err));
  }

  return redirectTo(req, "/rules");
}
