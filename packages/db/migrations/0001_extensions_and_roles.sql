-- Enables required extensions and creates the least-privilege role the
-- application connects as. Migrations run as the schema-owning role
-- (DATABASE_URL); the app must never connect as that role, because Postgres
-- does not apply row-level security policies to table owners or superusers.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD '${APP_USER_PASSWORD}';
  ELSE
    ALTER ROLE app_user WITH LOGIN PASSWORD '${APP_USER_PASSWORD}';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
