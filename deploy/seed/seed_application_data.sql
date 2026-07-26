-- Development application data: two tenants and everything they need to be useful.
--
-- Runs AFTER the migrator has applied the schema, which is why this is its own
-- file rather than another section of seed_database.sql - that one configures
-- the database itself and runs before any table exists.
--
--   dotnet run --project backend/src/Nix.Migrator   # schema first
--   deploy/seed/seed.sh                             # then this
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running changes
-- nothing and never fails on an existing volume.
--
-- Two tenants, not one. Every isolation test and every manual check of "can
-- Acme see Umbrella's folder" needs a second tenant to be a real question, and
-- a development database with one tenant quietly makes cross-tenant bugs
-- invisible until staging.

\set ON_ERROR_STOP on

-- The issuer is machine-specific: deploy/seed/zitadel-configure.sh writes it to
-- deploy/.zitadel/oidc.generated.env after Zitadel has bootstrapped. seed.sh
-- passes it through when that file exists. Without it the tenants and their
-- people are still seeded - only the identity provider registration is skipped,
-- because inventing an issuer would produce a registration that accepts no real
-- token and looks like it should.
\if :{?oidc_issuer} \else \set oidc_issuer '' \endif
\if :{?oidc_client_id} \else \set oidc_client_id '' \endif
\if :{?dev_user_id} \else \set dev_user_id '' \endif

DO $$
BEGIN
    IF to_regclass('public.tenant') IS NULL THEN
        RAISE EXCEPTION
            'the application schema is not present; run the migrator first: dotnet run --project backend/src/Nix.Migrator';
    END IF;
END
$$;

-- ── Tenants ────────────────────────────────────────────────────────────────
INSERT INTO tenant (tenant_id, name, isolation_mode, created_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'Acme',     'shared', now()),
    ('b0000000-0000-4000-8000-000000000002', 'Umbrella', 'shared', now())
ON CONFLICT (tenant_id) DO NOTHING;

-- ── Workspaces ─────────────────────────────────────────────────────────────
INSERT INTO workspace
    (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
     storage_quota_bytes, created_at)
VALUES
    ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'Acme Engineering', 90, 10, 10737418240, now()),
    ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
     'Acme Operations',  90, 10, 10737418240, now()),
    ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'Umbrella Research', 30, 5, 1073741824, now())
ON CONFLICT (workspace_id) DO NOTHING;

-- ── Principals ─────────────────────────────────────────────────────────────
-- external_subject is the issuer's subject claim. These match the demo users
-- zitadel-configure.sh provisions; until a real sign-in happens they are simply
-- rows that the authentication goal will resolve tokens onto.
INSERT INTO principal
    (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
VALUES
    ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'acme-admin',  'user', 'Ada Admin',   'ada@acme.test',       'active', NULL),
    ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
     'acme-editor', 'user', 'Eli Editor',  'eli@acme.test',       'active', NULL),

    -- A deprovisioned principal, seeded on purpose: the fail-closed path is the
    -- one nobody exercises by hand, and it needs a subject to exercise it with.
    ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
     'acme-former', 'user', 'Otto Former', 'otto@acme.test',      'deprovisioned', now()),

    ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'umbrella-admin', 'user', 'Uma Admin', 'uma@umbrella.test',  'active', NULL)
ON CONFLICT (principal_id) DO NOTHING;

-- Map the administrator onto the identity provider's real subject.
--
-- Core resolves a token's `sub` against principal.external_subject and refuses a
-- subject nobody provisioned - deliberately, because a valid token alone must
-- never be able to mint an identity. The placeholder above ('acme-admin') is
-- what the row carries before Zitadel exists; once zitadel-configure.sh has run
-- it writes the developer user's real id into oidc.generated.env, seed.sh passes
-- it here, and this statement points the administrator at it.
--
-- Without this, signing in through the browser succeeds at the identity provider
-- and is then refused by Core with "the token's subject is not provisioned in
-- this tenant" - which is correct behaviour reported against the wrong data.
UPDATE principal
SET external_subject = :'dev_user_id'
WHERE principal_id = 'a2000000-0000-4000-8000-000000000001'
  AND :'dev_user_id' <> '';

-- ── Groups ─────────────────────────────────────────────────────────────────
INSERT INTO principal_group (group_id, tenant_id, name, external_id) VALUES
    ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'Acme Engineers', 'acme-engineers'),
    ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'Umbrella Researchers', 'umbrella-researchers')
ON CONFLICT (group_id) DO NOTHING;

INSERT INTO group_membership (group_id, principal_id, tenant_id, source) VALUES
    ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002',
     'a0000000-0000-4000-8000-000000000001', 'directory'),
    ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
     'b0000000-0000-4000-8000-000000000002', 'directory')
ON CONFLICT (group_id, principal_id) DO NOTHING;

-- ── Role grants ────────────────────────────────────────────────────────────
-- The role vocabulary is defined by Nix.Core.Authorization.WorkspaceRole:
-- owner, editor, commenter, viewer, ordered by capability. Text outside that
-- set parses to nothing and grants nothing, so a typo here is a lockout rather
-- than an escalation. 'admin' on tenant_role is the tenant-wide role and is
-- separate from the workspace vocabulary.
INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'principal',
     'a2000000-0000-4000-8000-000000000001', 'admin',
     'a2000000-0000-4000-8000-000000000001', now()),
    ('b0000000-0000-4000-8000-000000000002', 'principal',
     'b2000000-0000-4000-8000-000000000001', 'admin',
     'b2000000-0000-4000-8000-000000000001', now())
ON CONFLICT (tenant_id, subject_type, subject_id) DO NOTHING;

INSERT INTO workspace_member
    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
VALUES
    ('a1000000-0000-4000-8000-000000000001', 'principal',
     'a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'owner',  'a2000000-0000-4000-8000-000000000001', now()),
    ('a1000000-0000-4000-8000-000000000001', 'group',
     'a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'editor', 'a2000000-0000-4000-8000-000000000001', now()),
    ('b1000000-0000-4000-8000-000000000001', 'principal',
     'b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'owner',  'b2000000-0000-4000-8000-000000000001', now())
ON CONFLICT (workspace_id, subject_type, subject_id) DO NOTHING;

-- ── Identity provider registration ─────────────────────────────────────────
-- Only when seed.sh supplied a real issuer. Registered against the first tenant,
-- which is the one the dev Zitadel instance is configured for.
-- A guarded INSERT ... SELECT rather than a DO block, because psql does not
-- substitute :variables inside dollar-quoted strings - the block would receive
-- the literal text and fail to parse.
INSERT INTO identity_provider
    (provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms, enabled)
SELECT
    'a4000000-0000-4000-8000-000000000001'::uuid,
    'a0000000-0000-4000-8000-000000000001'::uuid,
    :'oidc_issuer',
    :'oidc_client_id',
    :'oidc_issuer' || '/oauth/v2/keys',
    ARRAY['RS256']::text[],
    true
WHERE :'oidc_issuer' <> ''
ON CONFLICT (provider_id) DO NOTHING;

DO $$
BEGIN
    RAISE NOTICE 'application data seeded: 2 tenants, 3 workspaces, 4 principals';
END
$$;
