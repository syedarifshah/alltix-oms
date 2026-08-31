-- 0010 granted SELECT, UPDATE on tenants but omitted INSERT, so
-- provision-tenant.ts (the only code path that creates a tenant) could
-- never actually create one -- caught by the tenant-isolation e2e test in
-- packages/web/test/tenant-isolation.e2e.test.ts, which failed with
-- "permission denied for table tenants" before this fix.
GRANT INSERT ON tenants TO app_user;
