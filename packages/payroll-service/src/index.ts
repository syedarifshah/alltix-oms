import type { Pool, PoolClient } from "pg";
import { withTenant, encryptChannelSecret, decryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { captureError } from "@alltix/shared";

// Real Check payroll-processor integration (CLAUDE.md §0 locked scope
// decision, §14.1, task #34) -- service-layer half of this pass's "wired
// but unverified" build. Schema is migrations/0038_payroll_connections.sql;
// this is the client + tenant-scoped service functions that schema exists
// to back, built against Check's own documentation (docs.checkhq.com,
// fetched live via WebFetch this pass -- see CLAUDE.md §14.1's own updated
// notes for the exact pages and what each one confirmed).
//
// UNVERIFIED, same status as every connector in packages/channel-connectors
// carried before its own first real credentials arrived: no Check API key
// exists anywhere in this codebase or this tenant's account yet (a sales
// contact form was submitted -- Check has no self-serve sandbox signup, see
// CLAUDE.md §14.1) -- nothing in this file has round-tripped against
// sandbox.checkhq.com. Every field/endpoint below is marked CONFIRMED
// (fetched directly from a docs.checkhq.com reference page during this
// pass) or INFERRED (this codebase's own best-effort extrapolation from a
// confirmed sibling endpoint's shape, same "genuinely unconfirmed, not a
// documented fact" discipline TemuConnector's own class doc comment
// established) -- never silently presented as more certain than it is.
//
// Deliberately its own package, not folded into packages/channel-connectors
// -- Check is not a sales channel (no ChannelConnector interface methods --
// no orders, no listings, no inventory push) and packages/scheduler never
// needs to import it the way it imports every real channel connector for
// cron-driven order sync; this mirrors @alltix/billing-service's own
// placement (a single external vendor integration used only from
// packages/web) far more closely than it mirrors any channel adapter.
//
// time_entries (migration 0028) stays the system of record for hours
// worked -- CLAUDE.md §14.1 is explicit about this. Check becomes the
// system of record for money movement/tax compliance only, never a second
// place hours get tracked; nothing in this file writes to time_entries, and
// nothing in packages/db's own HR schema will ever gain a Check-owned hours
// column.

/** CONFIRMED -- docs.checkhq.com/reference/create-company's own example
 *  endpoint (`POST https://sandbox.checkhq.com/companies`). */
export const CHECK_SANDBOX_BASE_URL = "https://sandbox.checkhq.com";

/** CONFIRMED -- docs.checkhq.com/reference/getting-started-1: "production
 *  api.checkhq.com access" is granted only after Check verifies a real
 *  integration. No tenant in this codebase has reached that point yet (see
 *  this file's own class doc comment), so nothing here has ever
 *  constructed a client against this host outside typechecking -- kept as
 *  a named constant now so switching a real, verified tenant over later is
 *  a one-line change, not a hunt for a hardcoded sandbox URL. */
export const CHECK_PRODUCTION_BASE_URL = "https://api.checkhq.com";

/** CONFIRMED -- docs.checkhq.com/reference/authentication: `Authorization:
 *  Bearer <api_key>`, a sandbox key and a live key are issued separately.
 *  No separate API-version header was found documented anywhere in this
 *  pass's research (the `v2025-01-01` string seen in docs.checkhq.com's own
 *  navigation looked like a docs-site path segment, not a header Check's
 *  API reference ever asked a caller to send) -- if a real sandbox key
 *  later reveals one is required, add it here, in exactly one place. */
function buildCheckHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Thrown by every {@link CheckClient} method on a non-2xx response --
 *  carries the raw HTTP status so callers (e.g. {@link CheckClient.verifyApiKey})
 *  can distinguish "bad/expired key" (401/403) from "Check is having a bad
 *  day" (5xx) without re-parsing a message string. */
export class CheckApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    bodyText: string,
  ) {
    super(`Check API ${status} on ${path}: ${bodyText || "(empty body)"}`);
    this.name = "CheckApiError";
  }
}

export interface CheckCompanyParams {
  legalName: string;
  /** CONFIRMED enum -- docs.checkhq.com/reference/create-company. */
  businessType: "sole_proprietorship" | "partnership" | "c_corporation" | "s_corporation" | "llc";
  tradeName?: string;
  industryType?: string;
  email?: string;
  phone?: string;
  payFrequency?: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "annually";
  /** ISO date (YYYY-MM-DD) -- "First payday using Check," per the same
   *  reference page. */
  startDate?: string;
}

/** Loosely typed on purpose -- this pass never got a real example response
 *  body for company creation (the reference page's own extracted content
 *  confirmed the 201 status and echoed request fields but not a full
 *  sample JSON payload), so this only asserts the one field every caller in
 *  this file actually depends on (`id`) rather than a shape that would
 *  silently go stale the moment a real sandbox response is seen. */
export interface CheckCompany {
  id: string;
  [key: string]: unknown;
}

export interface CheckWorkplaceParams {
  companyId: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  };
}

/** INFERRED endpoint (`POST /workplaces`) -- docs.checkhq.com/docs/quickstart
 *  CONFIRMED that "Create a workplace" is a required step before employees
 *  can be created (employees.workplaces references workplace ids), but this
 *  pass never fetched a dedicated Workplace API reference page to confirm
 *  the exact path/field names -- `POST /workplaces` with a `company` field
 *  and an `address` object follows the same resource-per-noun,
 *  company-scoped-by-field (not by path segment) convention
 *  create-company/create-an-employee both confirm, but treat this one
 *  specifically as unconfirmed until a real sandbox key can verify it. */
export interface CheckWorkplace {
  id: string;
  [key: string]: unknown;
}

export interface CheckEmployeeParams {
  companyId: string;
  workplaceIds: string[];
  lastName: string;
  firstName?: string;
  middleName?: string;
  email?: string;
  /** ISO date -- CONFIRMED "Until dob is added, it will show up as a
   *  blocking employee onboard step" (docs.checkhq.com/reference/create-an-employee). */
  dob?: string;
  /** CONFIRMED "Only the last four digits of an SSN will be made available
   *  in `ssn_last_four`" afterward -- never round-tripped back out of this
   *  file once sent. */
  ssn?: string;
  startDate?: string;
  paymentMethodPreference?: "direct_deposit" | "manual";
}

export interface CheckEmployee {
  id: string;
  [key: string]: unknown;
}

/** CONFIRMED status enum -- docs.checkhq.com/docs/onboard-status: the
 *  `onboard` object appears directly on `company`/`employee`/`contractor`
 *  resources (no dedicated status endpoint), with `status` one of these
 *  three values. */
export type CheckOnboardStatus = "completed" | "needs_attention" | "blocking";

export interface CheckOnboardState {
  status: CheckOnboardStatus;
  blockingSteps: string[];
  remainingSteps: string[];
}

/** Which Check Component to generate a one-time link for. `company_onboard`
 *  is INFERRED (the Component Library groups "Company Onboard" under
 *  "Company Components," and this pass's own fetch of
 *  docs.checkhq.com/docs/check-onboard confirmed company onboarding is
 *  triggered by generating a one-time link via an API request, but never
 *  landed on that link-generation endpoint's own dedicated reference page
 *  to confirm its exact component-type slug). `employee_onboard` is
 *  likewise INFERRED, by the same reasoning, scoped to the employee
 *  resource per the Component Library's "Employee Components" category
 *  rather than the company resource. `run_payroll` is the one CONFIRMED
 *  value here -- docs.checkhq.com/reference/run-payroll gave the exact
 *  endpoint (`POST /companies/{company}/components/run_payroll`), which is
 *  what the other two slugs are inferred BY SYMMETRY with. */
export type CheckComponentType = "company_onboard" | "employee_onboard" | "run_payroll";

export interface CheckComponentLinkOptions {
  /** Required only for `company_onboard` -- CONFIRMED
   *  (docs.checkhq.com/docs/check-onboard): "Requires signer name, title,
   *  and email address during link generation" for a company; an
   *  employee/contractor onboard link needs neither (their own record
   *  already carries name/email). */
  signerName?: string;
  signerTitle?: string;
  signerEmail?: string;
  /** `run_payroll` only -- CONFIRMED optional query param
   *  (docs.checkhq.com/reference/run-payroll): launches the component in
   *  edit-view mode for an existing payroll id instead of starting a new
   *  one. */
  payrollId?: string;
}

/** Loosely typed -- this pass never fetched a literal example JSON response
 *  for a components-link call, only prose describing what it returns (a
 *  URL suitable for `<iframe src>` or `window.CheckComponent.create({link})`
 *  -- docs.checkhq.com/docs/embedding-a-component). `link` is populated
 *  defensively from whichever of a few plausible field names the raw
 *  response actually uses (see {@link parseComponentLinkResponse}) rather
 *  than assuming one -- this is the single field in this whole file most
 *  likely to need a one-line fix the moment a real sandbox response is
 *  seen, and this is where that fix belongs. */
export interface CheckComponentLink {
  link: string;
  raw: Record<string, unknown>;
}

function parseComponentLinkResponse(raw: unknown): CheckComponentLink {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const link = obj.link ?? obj.component_link ?? obj.url;
  if (typeof link !== "string" || !link) {
    throw new Error(
      `Check components response did not contain a recognizable link field (checked link/component_link/url) -- raw response: ${JSON.stringify(obj)}`,
    );
  }
  return { link, raw: obj };
}

/**
 * Thin REST client for the Check API -- deliberately no vendor SDK
 * dependency (unlike @alltix/billing-service's own `stripe` package): no
 * official or credible community Node/TypeScript SDK for Check was found
 * during this pass's research (unlike Temu's own installed community
 * `temu_api` Python package -- see TemuConnector's class doc comment for
 * that precedent), so this talks to Check's plain REST/JSON API directly
 * via `fetch`, the same "no SDK, hand-roll the HTTP" shape
 * AmazonConnector's own SP-API calls use.
 */
export class CheckClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = CHECK_SANDBOX_BASE_URL,
  ) {}

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: buildCheckHeaders(this.apiKey),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new CheckApiError(response.status, path, bodyText);
    }
    return (await response.json()) as T;
  }

  /** INFERRED verification call -- no dedicated "verify this API key"
   *  endpoint was found documented anywhere in this pass's research, so
   *  this reuses the same POST /companies collection create-company
   *  confirms exists, but as a GET (a standard REST list-the-collection
   *  convention, same reasoning ShopifyConnector.verifyConnection()'s own
   *  doc comment gives for its own lightweight read-only check) -- a
   *  401/403 here means "this key doesn't authenticate," which is all
   *  {@link connectPayrollProcessor} below needs before persisting
   *  anything. Same "verify before persist" discipline every other
   *  connector's own connect route in this codebase already follows. */
  async verifyApiKey(): Promise<void> {
    await this.request<unknown>("GET", "/companies?page_size=1");
  }

  /** CONFIRMED -- docs.checkhq.com/reference/create-company:
   *  `POST /companies`, required `legal_name`/`business_type`, response 201
   *  returns the created company object. */
  async createCompany(params: CheckCompanyParams): Promise<CheckCompany> {
    return this.request<CheckCompany>("POST", "/companies", {
      legal_name: params.legalName,
      business_type: params.businessType,
      trade_name: params.tradeName,
      industry_type: params.industryType,
      email: params.email,
      phone: params.phone,
      pay_frequency: params.payFrequency,
      start_date: params.startDate,
    });
  }

  /** CONFIRMED -- the `onboard` object is exposed directly on the company
   *  resource (docs.checkhq.com/docs/onboard-status), so reading onboard
   *  status is just a GET of the company itself; no separate status
   *  endpoint exists. */
  async getCompany(companyId: string): Promise<CheckCompany & { onboard?: CheckOnboardState }> {
    return this.request<CheckCompany & { onboard?: CheckOnboardState }>("GET", `/companies/${companyId}`);
  }

  /** INFERRED endpoint -- see {@link CheckWorkplace}'s own doc comment. */
  async createWorkplace(params: CheckWorkplaceParams): Promise<CheckWorkplace> {
    return this.request<CheckWorkplace>("POST", "/workplaces", {
      company: params.companyId,
      address: {
        line1: params.address.line1,
        line2: params.address.line2,
        city: params.address.city,
        state: params.address.state,
        postal_code: params.address.postalCode,
        country: params.address.country ?? "US",
      },
    });
  }

  /** CONFIRMED -- docs.checkhq.com/reference/create-an-employee:
   *  `POST /employees`, required `last_name`/`company`/`workplaces`,
   *  response 201 returns the created employee object. */
  async createEmployee(params: CheckEmployeeParams): Promise<CheckEmployee> {
    return this.request<CheckEmployee>("POST", "/employees", {
      company: params.companyId,
      workplaces: params.workplaceIds,
      last_name: params.lastName,
      first_name: params.firstName,
      middle_name: params.middleName,
      email: params.email,
      dob: params.dob,
      ssn: params.ssn,
      start_date: params.startDate,
      payment_method_preference: params.paymentMethodPreference,
    });
  }

  /** CONFIRMED for `run_payroll` (docs.checkhq.com/reference/run-payroll:
   *  `POST /companies/{company}/components/run_payroll`); INFERRED for
   *  `company_onboard`/`employee_onboard` -- see {@link CheckComponentType}'s
   *  own doc comment. `resourceId` is a company id for `company_onboard`/
   *  `run_payroll` and a Check employee id for `employee_onboard` --
   *  callers never construct the path themselves so this stays the one
   *  place that distinction is encoded. */
  async createComponentLink(
    type: CheckComponentType,
    resourceId: string,
    options: CheckComponentLinkOptions = {},
  ): Promise<CheckComponentLink> {
    const resourcePath = type === "employee_onboard" ? "employees" : "companies";
    const query = type === "run_payroll" && options.payrollId ? `?payroll=${encodeURIComponent(options.payrollId)}` : "";
    const raw = await this.request<unknown>("POST", `/${resourcePath}/${resourceId}/components/${type}${query}`, {
      signer_name: options.signerName,
      signer_title: options.signerTitle,
      signer_email: options.signerEmail,
    });
    return parseComponentLinkResponse(raw);
  }
}

// ---------------------------------------------------------------------------
// Tenant-scoped service layer -- everything packages/web's /settings/payroll
// routes actually call. Mirrors @alltix/billing-service's own split (a thin
// vendor client above, tenant/db-aware functions below) rather than making
// route handlers reach into CheckClient directly.

export interface PayrollConnection {
  id: string;
  tenantId: string;
  checkCompanyId: string | null;
  status: string;
  createdAt: string;
}

interface PayrollConnectionRow {
  id: string;
  tenant_id: string;
  check_company_id: string | null;
  status: string;
  created_at: string;
}

function toPayrollConnection(row: PayrollConnectionRow): PayrollConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    checkCompanyId: row.check_company_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getPayrollConnection(pool: Pool, tenantId: string): Promise<PayrollConnection | null> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<PayrollConnectionRow>(
      `SELECT id, tenant_id, check_company_id, status, created_at
         FROM payroll_connections
        WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ? toPayrollConnection(result.rows[0]) : null;
  });
}

/** Loads and decrypts this tenant's Check API key, constructing a
 *  {@link CheckClient} against the sandbox host -- CLAUDE.md §14.1 and this
 *  file's own class doc comment: nothing in this codebase has a verified,
 *  production-ready Check integration yet, so unlike
 *  createWalmartConnectorFromChannelConnection (which always targets
 *  Walmart production -- a real tenant connecting their real seller
 *  account), every call in this pass targets {@link CHECK_SANDBOX_BASE_URL}
 *  unconditionally. Throws if this tenant has never connected Check at
 *  all -- there's nothing to build a client from. */
async function getCheckClientForTenant(client: PoolClient, tenantId: string): Promise<{ apiClient: CheckClient; companyId: string | null }> {
  const result = await client.query<{ encrypted_api_key: Buffer; check_company_id: string | null }>(
    `SELECT encrypted_api_key, check_company_id FROM payroll_connections WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Tenant ${tenantId} has not connected a Check payroll processor yet`);
  }
  const apiKey = await decryptChannelSecret(client, row.encrypted_api_key);
  return { apiClient: new CheckClient(apiKey, CHECK_SANDBOX_BASE_URL), companyId: row.check_company_id };
}

/**
 * Verifies `apiKey` against real Check sandbox infrastructure
 * (CheckClient.verifyApiKey(), a live network call -- same "verify before
 * persist" discipline every other channel's own connect route in this
 * codebase already follows, e.g. WalmartConnector.authenticate() in
 * /api/channels/walmart/connect) before persisting it, then upserts one
 * `payroll_connections` row per tenant (CLAUDE.md §14.1: one processor per
 * tenant, not one row per external account the way channel_connections is).
 *
 * Reconnecting with a new key updates the existing row in place rather than
 * inserting a second one -- payroll_connections.tenant_id is UNIQUE
 * (migration 0038), unlike channel_connections' own four-column uniqueness,
 * so there is never more than one Check connection to reconcile per tenant.
 */
export async function connectPayrollProcessor(
  pool: Pool,
  tenantId: string,
  apiKey: string,
  actorUserId: string | null,
): Promise<PayrollConnection> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error("apiKey is required");
  }

  // Real network call against sandbox.checkhq.com, before anything is
  // persisted -- CheckApiError's own status field lets a bad/expired key
  // surface as a clear message rather than a generic fetch failure.
  await new CheckClient(trimmedKey, CHECK_SANDBOX_BASE_URL).verifyApiKey();

  return withTenant(pool, tenantId, async (client) => {
    const encryptedApiKey = await encryptChannelSecret(client, trimmedKey);
    const result = await client.query<{ id: string; check_company_id: string | null; created_at: string; is_new: boolean }>(
      `INSERT INTO payroll_connections (tenant_id, encrypted_api_key, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (tenant_id) DO UPDATE SET
         encrypted_api_key = EXCLUDED.encrypted_api_key,
         status = 'active',
         updated_at = now()
       RETURNING id, check_company_id, created_at, (xmax = 0) AS is_new`,
      [tenantId, encryptedApiKey],
    );
    const row = result.rows[0]!;

    // Never logs the key itself -- same discipline as every other
    // connect route's own audit write in this codebase (see e.g.
    // /api/channels/walmart/connect's identical comment).
    await recordAuditEvent(client, {
      tenantId,
      userId: actorUserId,
      action: row.is_new ? "payroll.connected" : "payroll.credentials_rotated",
      entityType: "payroll_connection",
      entityId: row.id,
      details: {},
    });

    return toPayrollConnection({
      id: row.id,
      tenant_id: tenantId,
      check_company_id: row.check_company_id,
      status: "active",
      created_at: row.created_at,
    });
  });
}

/** Creates the Check Company resource itself, the step after
 *  {@link connectPayrollProcessor} (an API key alone authenticates but
 *  doesn't identify which employer this tenant IS to Check -- CONFIRMED,
 *  docs.checkhq.com/reference/create-company). Stores the returned company
 *  id on the tenant's existing `payroll_connections` row rather than a
 *  second table -- one processor, one company, per tenant (CLAUDE.md
 *  §14.1). Throws if a company was already created for this tenant instead
 *  of silently creating a second one Check-side that this schema has no
 *  room to track (`check_company_id` is a single nullable column, not an
 *  array) -- same "expand-only, first write wins" discipline
 *  {@link linkEmployeeToCheck} below applies to `employees.check_employee_id`. */
export async function createCheckCompanyForTenant(
  pool: Pool,
  tenantId: string,
  params: CheckCompanyParams,
  actorUserId: string | null,
): Promise<CheckCompany> {
  return withTenant(pool, tenantId, async (client) => {
    const { apiClient, companyId } = await getCheckClientForTenant(client, tenantId);
    if (companyId) {
      throw new Error(`Tenant ${tenantId} already has a Check company (${companyId}) -- only one is supported per tenant`);
    }

    const company = await apiClient.createCompany(params);

    await client.query(`UPDATE payroll_connections SET check_company_id = $1, updated_at = now() WHERE tenant_id = $2`, [
      company.id,
      tenantId,
    ]);

    await recordAuditEvent(client, {
      tenantId,
      userId: actorUserId,
      action: "payroll.company_created",
      entityType: "payroll_connection",
      entityId: company.id,
      details: { legalName: params.legalName, businessType: params.businessType },
    });

    return company;
  });
}

/** Generates a one-time Check Onboard component link for the tenant's own
 *  Check Company (`/settings/payroll`'s "Launch company onboarding"
 *  embedding point) -- CONFIRMED single-use, active 24 hours
 *  (docs.checkhq.com/docs/check-onboard). Never cached: "Each page reload
 *  requires a new Component URL to be generated for security purposes"
 *  (docs.checkhq.com/docs/embedding-a-component) -- callers must generate a
 *  fresh link on every page load, never reuse a previously returned one. */
export async function generateCompanyOnboardLink(
  pool: Pool,
  tenantId: string,
  signer: { name: string; title: string; email: string },
): Promise<CheckComponentLink> {
  return withTenant(pool, tenantId, async (client) => {
    const { apiClient, companyId } = await getCheckClientForTenant(client, tenantId);
    if (!companyId) {
      throw new Error(`Tenant ${tenantId} has not created a Check company yet`);
    }
    return apiClient.createComponentLink("company_onboard", companyId, {
      signerName: signer.name,
      signerTitle: signer.title,
      signerEmail: signer.email,
    });
  });
}

/** Generates a one-time Run Payroll component link
 *  (`/settings/payroll`'s "Run payroll" embedding point) -- CONFIRMED
 *  prerequisites (docs.checkhq.com/reference/run-payroll): the company must
 *  have at least one employee/contractor, at least one pay schedule, and
 *  onboard status `completed`. This function does not check any of those
 *  itself -- it's a live call straight to Check, which will reject the
 *  request with its own error if a prerequisite isn't met, same as every
 *  other "let the vendor's own API be the source of truth for its own
 *  business rules" precedent in this codebase (e.g. eBay's business
 *  policies form). */
export async function generateRunPayrollLink(pool: Pool, tenantId: string, payrollId?: string): Promise<CheckComponentLink> {
  return withTenant(pool, tenantId, async (client) => {
    const { apiClient, companyId } = await getCheckClientForTenant(client, tenantId);
    if (!companyId) {
      throw new Error(`Tenant ${tenantId} has not created a Check company yet`);
    }
    return apiClient.createComponentLink("run_payroll", companyId, { payrollId });
  });
}

/**
 * Creates the Check-side Employee resource for a local `employees` row and
 * links the two (`employees.check_employee_id`, migration 0038) --
 * expand-only: refuses to run again for an employee that's already linked,
 * same "first write wins, never silently overwritten" discipline as
 * orders.channel_connection_id's own doc comment describes for that
 * column. `workplaceIds` is a required parameter here, not resolved
 * automatically -- this pass builds {@link CheckClient.createWorkplace} but
 * no UI/service function decides which of a tenant's `locations` rows
 * should become which Check Workplace, since that mapping (and whether it
 * should be 1:1 with `locations` at all) is exactly the kind of design
 * decision CLAUDE.md §14.1 calls out as still-open -- callers must resolve
 * or create a workplace id themselves before calling this.
 */
export async function linkEmployeeToCheck(
  pool: Pool,
  tenantId: string,
  employeeId: string,
  workplaceIds: string[],
  actorUserId: string | null,
): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const { apiClient, companyId } = await getCheckClientForTenant(client, tenantId);
    if (!companyId) {
      throw new Error(`Tenant ${tenantId} has not created a Check company yet`);
    }

    const employeeResult = await client.query<{ id: string; name: string; check_employee_id: string | null }>(
      `SELECT id, name, check_employee_id FROM employees WHERE tenant_id = $1 AND id = $2`,
      [tenantId, employeeId],
    );
    const employee = employeeResult.rows[0];
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found for tenant ${tenantId}`);
    }
    if (employee.check_employee_id) {
      throw new Error(`Employee ${employeeId} is already linked to Check employee ${employee.check_employee_id}`);
    }

    // employees.name is one free-text field (migration 0028) -- Check wants
    // last_name required, first_name optional, so this is a best-effort
    // split, not a real structured-name model. A tenant can always correct
    // the split later from within Check Onboard itself (or Check's own
    // Dashboard), which owns the authoritative name once onboarding starts.
    const nameParts = employee.name.trim().split(/\s+/);
    const firstName = nameParts[0]!;
    const rest = nameParts.slice(1);
    const lastName = rest.length > 0 ? rest.join(" ") : firstName;

    const checkEmployee = await apiClient.createEmployee({
      companyId,
      workplaceIds,
      firstName: rest.length > 0 ? firstName : undefined,
      lastName,
    });

    const updateResult = await client.query(
      `UPDATE employees SET check_employee_id = $1, updated_at = now()
        WHERE tenant_id = $2 AND id = $3 AND check_employee_id IS NULL`,
      [checkEmployee.id, tenantId, employeeId],
    );
    if (updateResult.rowCount === 0) {
      // Lost a race with another request linking the same employee between
      // the SELECT above and this UPDATE -- surfaced as an error rather
      // than silently overwritten, same expand-only discipline this
      // function's own doc comment describes.
      throw new Error(`Employee ${employeeId} was linked to Check by a concurrent request -- reload and try again`);
    }

    await recordAuditEvent(client, {
      tenantId,
      userId: actorUserId,
      action: "payroll.employee_linked",
      entityType: "employee",
      entityId: employeeId,
      details: { checkEmployeeId: checkEmployee.id },
    });

    return checkEmployee.id;
  });
}

/** Generates a one-time Employee Onboard component link for an employee
 *  already linked via {@link linkEmployeeToCheck}. Same "generate fresh on
 *  every page load, never cache" rule as
 *  {@link generateCompanyOnboardLink}. */
export async function generateEmployeeOnboardLink(pool: Pool, tenantId: string, employeeId: string): Promise<CheckComponentLink> {
  return withTenant(pool, tenantId, async (client) => {
    const { apiClient } = await getCheckClientForTenant(client, tenantId);
    const result = await client.query<{ check_employee_id: string | null }>(
      `SELECT check_employee_id FROM employees WHERE tenant_id = $1 AND id = $2`,
      [tenantId, employeeId],
    );
    const checkEmployeeId = result.rows[0]?.check_employee_id;
    if (!checkEmployeeId) {
      throw new Error(`Employee ${employeeId} is not linked to a Check employee yet -- link it first`);
    }
    return apiClient.createComponentLink("employee_onboard", checkEmployeeId);
  });
}

/** Reads a company's live onboard status straight from Check (CONFIRMED
 *  shape, docs.checkhq.com/docs/onboard-status) -- never cached/stored
 *  locally, so `/settings/payroll` always shows Check's own current view,
 *  not a snapshot that could silently drift. Wrapped in the same
 *  try/catch-and-report shape as ChannelsSettingsPage's own eBay business
 *  policies fetch (packages/web/src/app/(app)/settings/channels/page.tsx)
 *  -- a Check outage or an unverified integration failing here should
 *  degrade to an error message, not take down the whole settings page. */
export async function getCompanyOnboardStatus(pool: Pool, tenantId: string): Promise<CheckOnboardState | null> {
  try {
    return await withTenant(pool, tenantId, async (client) => {
      const { apiClient, companyId } = await getCheckClientForTenant(client, tenantId);
      if (!companyId) return null;
      const company = await apiClient.getCompany(companyId);
      return company.onboard ?? null;
    });
  } catch (err) {
    captureError(err, { tenantId, context: "getCompanyOnboardStatus" });
    return null;
  }
}
