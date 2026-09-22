-- CLAUDE.md §6's Security & Compliance list flags this as unaddressed:
-- "Rate-limit/DDoS protection on the public API -- a buggy customer
-- integration script can otherwise take the platform down." This is that
-- protection for today's actual surface: the session-authenticated
-- mutation routes under packages/web/src/app/api (there is no separate,
-- API-key-authenticated public API yet -- see the new "API Rate Limiting"
-- section of CLAUDE.md for the honest scope note on that distinction).
--
-- Fixed-window counter, not a token bucket or a Redis/Upstash-backed
-- sliding window -- same "don't stand up infra a single self-testing
-- tenant hasn't earned yet" call this codebase already makes for
-- BullMQ/Redis (§4.4), Kafka (§1), and the channel feature flags (§15).
-- One row per (tenant, route, one-minute window); packages/web/src/lib/
-- rate-limit.ts does an atomic INSERT ... ON CONFLICT DO UPDATE
-- increment-and-check against it.
--
-- No periodic cleanup job in this pass -- deliberately deferred, same
-- "add the infra once actual scale demands it" call §15 already makes for
-- not building an operator UI. At one row per tenant/route/minute, this
-- table grows slowly enough (well under the free tier of any Postgres host
-- this platform would run on at its current single-self-testing-tenant
-- stage) that a scheduled `DELETE WHERE window_start < now() - interval
-- '1 day'` is real, cheap, future work once it's worth writing -- not
-- attempted here.
CREATE TABLE api_rate_limit_windows (
  tenant_id UUID NOT NULL,
  -- A short, stable identifier for the route being limited (e.g.
  -- 'orders.cancel', 'inventory.transfer') -- see rate-limit.ts's own doc
  -- comment for the naming convention. Free TEXT, not a fixed enum -- same
  -- "this app's own vocabulary keeps growing" reasoning employees.role
  -- already gives (migration 0028) -- a new protected route just needs a
  -- new string here, not a schema change.
  route_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INT NOT NULL DEFAULT 0 CHECK (request_count > 0),
  PRIMARY KEY (tenant_id, route_key, window_start)
);

ALTER TABLE api_rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limit_windows FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_api_rate_limit_windows ON api_rate_limit_windows
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- No DELETE grant -- this pass never deletes a row (see the "no cleanup
-- job" note above); INSERT/UPDATE/SELECT cover everything
-- recordRequestAndCheckRateLimit actually does.
GRANT SELECT, INSERT, UPDATE ON api_rate_limit_windows TO app_user;
