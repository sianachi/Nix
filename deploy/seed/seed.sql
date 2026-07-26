-- Nix development database seed.
--
-- Idempotent by construction: every statement is guarded, so running this
-- twice is a no-op and safe against an existing volume. It is applied two
-- ways, both of which run this same file:
--   - automatically on the first boot of an empty volume, by the init script
--     mounted into /docker-entrypoint-initdb.d
--   - on demand at any time, by deploy/seed/seed.sh
--
-- Scope note: the application schema does not exist yet (it lands with the
-- tenancy goal, which adds migrations). This file therefore establishes only
-- what the database itself owns: the database, the extensions, and the two
-- roles of the security model. Row seeding lives in seed_application_data()
-- at the bottom, which is deliberately empty until the schema exists.
--
-- Roles, per the security model:
--   nix_migrator - owns the schema, runs migrations. The ONLY role that may
--                  hold BYPASSRLS. Migrations run as a job, never at app start.
--   nix_app      - the application's runtime role. MUST NOT have BYPASSRLS:
--                  row-level security is the tenant isolation boundary, and a
--                  role that can bypass it makes every RLS policy decorative.

\set ON_ERROR_STOP on

-- Passwords come from the environment so this file carries no secrets.
-- psql substitutes them via -v; the defaults match compose's dev defaults.
\if :{?app_password} \else \set app_password 'nix-dev-app' \endif
\if :{?migrator_password} \else \set migrator_password 'nix-dev-migrator' \endif
\if :{?db_name} \else \set db_name 'nix' \endif

-- ── Roles ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nix_migrator') THEN
        CREATE ROLE nix_migrator LOGIN;
        RAISE NOTICE 'created role nix_migrator';
    ELSE
        RAISE NOTICE 'role nix_migrator already present';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nix_app') THEN
        CREATE ROLE nix_app LOGIN;
        RAISE NOTICE 'created role nix_app';
    ELSE
        RAISE NOTICE 'role nix_app already present';
    END IF;
END
$$;

-- Passwords are set every run so rotating them in .env takes effect.
ALTER ROLE nix_migrator WITH PASSWORD :'migrator_password';
ALTER ROLE nix_app WITH PASSWORD :'app_password';

-- The security-critical pair of attributes. Stated positively for the
-- migrator and negatively for the app role, and asserted below.
ALTER ROLE nix_migrator WITH BYPASSRLS;
ALTER ROLE nix_app WITH NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

DO $$
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'nix_app') THEN
        RAISE EXCEPTION
            'nix_app has BYPASSRLS; row-level security would not isolate tenants';
    END IF;
    RAISE NOTICE 'verified nix_app cannot bypass row-level security';
END
$$;
