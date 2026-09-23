-- Rate limiting for the one mutation route CLAUDE.md §16's own "fourth pass"
-- correction flagged as still open: POST /api/leads/demo-request. Every
-- other rate-limited route in this app is session-authenticated, so
-- migration 0033's api_rate_limit_windows keys by tenant_id -- but
-- demo-request is public and unauthenticated by design (see that route's
-- own doc comment, and migrations/0017_demo_requests.sql's matching "not
-- tenant data" reasoning), so there's no tenant_id to key a window by at
-- all. Same fixed-one-minute-window design as 0033, just keyed by the
-- requester's own IP address (packages/web/src/lib/rate-limit.ts's
-- getClientIp()) instead.
CREATE TABLE public_ip_rate_limit_windows (
  ip_address TEXT NOT NULL,
  -- Same free-TEXT, dot-namespaced convention as api_rate_limit_windows.
  -- route_key -- one table can outlive a single route if a second public,
  -- unauthenticated mutation route is ever added.
  route_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INT NOT NULL DEFAULT 0 CHECK (request_count > 0),
  PRIMARY KEY (ip_address, route_key, window_start)
);

ALTER TABLE public_ip_rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_ip_rate_limit_windows FORCE ROW LEVEL SECURITY;

-- No tenant_id to scope a policy by -- app_user is this table's only
-- reader/writer either way (no other DB role is ever granted access), so a
-- USING(true) policy is the correct minimal-but-real RLS posture here, same
-- "RLS stays on even where there's no tenant to isolate by" precedent
-- demo_requests' own public_insert_demo_requests policy already set for a
-- different operation (§6's "defense-in-depth, never rely on one layer
-- alone" -- this is that layer for "not tenant data" tables too, not just
-- tenant ones).
CREATE POLICY app_user_full_access_public_ip_rate_limit_windows ON public_ip_rate_limit_windows
  USING (true)
  WITH CHECK (true);

-- SELECT is required for this table's own INSERT ... ON CONFLICT DO UPDATE
-- ... RETURNING request_count pattern (same reasoning 0033's own GRANT
-- comment gives for api_rate_limit_windows) -- no DELETE, picked up instead
-- by extending the existing cleanupRateLimitWindows job
-- (packages/scheduler/src/index.ts) to sweep this table too, on the same
-- daily cron, rather than standing up a second cleanup job for a second
-- rate-limit table.
GRANT SELECT, INSERT, UPDATE ON public_ip_rate_limit_windows TO app_user;
