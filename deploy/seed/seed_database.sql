-- Per-database seed: extensions, ownership, and grants.
--
-- Runs inside the application database (seed.sql creates roles at the cluster
-- level; this file configures the database itself). Idempotent throughout.

\set ON_ERROR_STOP on

-- pgvector is required by the retrieval milestone and is created up front so
-- migrations never have to run as superuser to add it later.
CREATE EXTENSION IF NOT EXISTS vector;

-- The migrator owns the schema; the app role only uses what it is granted.
ALTER SCHEMA public OWNER TO nix_migrator;

GRANT CONNECT ON DATABASE :"db_name" TO nix_app, nix_migrator;
GRANT USAGE ON SCHEMA public TO nix_app;

-- The app role must never create objects; migrations do that as nix_migrator.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM nix_app;

-- Table-level grants for future migrations: anything nix_migrator creates in
-- public is automatically readable/writable by nix_app. Per-table grants in
-- the migrations themselves still narrow this per the ownership matrix (for
-- example audit tables are INSERT-only); this default keeps the app working
-- without a grant statement after every migration.
ALTER DEFAULT PRIVILEGES FOR ROLE nix_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nix_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO nix_app;

DO $$
BEGIN
    RAISE NOTICE 'database seed applied: pgvector present, grants configured';
END
$$;

-- ── Application data ───────────────────────────────────────────────────────
-- Lives in seed_application_data.sql, not here, because it needs tables and
-- this file runs before any exist: the order is roles, database, grants (this
-- file), then the migrator, then rows. seed.sh applies that last step only when
-- the schema is present, so running it against a fresh database is still a
-- no-op rather than an error.
