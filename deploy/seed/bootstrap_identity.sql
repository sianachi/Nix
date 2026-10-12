-- Production identity bootstrap: one tenant and its two identity-provider registrations.
--
-- A fresh installation has no tenant and no identity_provider row, so Core cannot resolve any
-- token and nobody can sign in. The dev seed (seed_application_data.sql) creates those rows for
-- its demo tenants; this file is the production counterpart and creates nothing else.
--
-- Operator note:
--   Run after the migrator, as a role that bypasses RLS (the superuser or nix_migrator).
--   Kubernetes: NIX_BOOTSTRAP_IDENTITY=true deploy/k8s/deploy.sh (see that script's header).
--   Compose:    NIX_BOOTSTRAP_IDENTITY=true deploy/compose/deploy.sh (values from the env file).
--   By hand:
--     psql -v ON_ERROR_STOP=1 -d nix \
--       -v tenant_name='Example' \
--       -v oidc_issuer='https://auth.example.com' \
--       -v oidc_client_id='<web application client id>' \
--       -v oidc_project_id='<identity provider project id>' \
--       [-v tenant_id='<uuid>'] \
--       -f deploy/seed/bootstrap_identity.sql
--
--   oidc_client_id is the browser application's audience (JIT provisioning on).
--   oidc_project_id is the audience of machine tokens (JWT-profile service accounts; JIT off).
--   tenant_id is optional: without it the tenant is found by exact name or created with a new id.
--
-- Idempotent: re-running never changes an existing registration (an operator's disable or JIT
-- change survives); a new client id or project id adds that registration. It never modifies a
-- tenant other than the target one, and it refuses an issuer/audience pair already registered to
-- another tenant instead of moving it.

\set ON_ERROR_STOP on

\if :{?tenant_name} \else \set tenant_name '' \endif
\if :{?tenant_id} \else \set tenant_id '' \endif
\if :{?oidc_issuer} \else \set oidc_issuer '' \endif
\if :{?oidc_client_id} \else \set oidc_client_id '' \endif
\if :{?oidc_project_id} \else \set oidc_project_id '' \endif

-- psql does not substitute :variables inside a dollar-quoted block, so pass them as
-- transaction-local settings the block can read.
BEGIN;
SET LOCAL nix.bootstrap.tenant_name = :'tenant_name';
SET LOCAL nix.bootstrap.tenant_id = :'tenant_id';
SET LOCAL nix.bootstrap.oidc_issuer = :'oidc_issuer';
SET LOCAL nix.bootstrap.oidc_client_id = :'oidc_client_id';
SET LOCAL nix.bootstrap.oidc_project_id = :'oidc_project_id';

DO $$
DECLARE
    v_name      text := btrim(current_setting('nix.bootstrap.tenant_name'));
    v_tenant    text := btrim(current_setting('nix.bootstrap.tenant_id'));
    v_issuer    text := btrim(current_setting('nix.bootstrap.oidc_issuer'));
    v_client    text := btrim(current_setting('nix.bootstrap.oidc_client_id'));
    v_project   text := btrim(current_setting('nix.bootstrap.oidc_project_id'));
    v_tenant_id uuid;
    v_matches   int;
    v_audience  text;
    v_jit       boolean;
    v_rows      int;
BEGIN
    IF to_regclass('public.tenant') IS NULL OR to_regclass('public.identity_provider') IS NULL THEN
        RAISE EXCEPTION 'the application schema is not present; run the migrator first';
    END IF;
    IF v_name = '' THEN RAISE EXCEPTION 'tenant_name is required'; END IF;
    IF v_issuer = '' THEN RAISE EXCEPTION 'oidc_issuer is required'; END IF;
    IF v_client = '' THEN RAISE EXCEPTION 'oidc_client_id is required'; END IF;
    IF v_project = '' THEN RAISE EXCEPTION 'oidc_project_id is required'; END IF;
    IF v_issuer !~ '^https?://[^/]' OR v_issuer ~ '/$' THEN
        RAISE EXCEPTION 'oidc_issuer must be an http(s) URL without a trailing slash, exactly as tokens carry it';
    END IF;
    IF v_client = v_project THEN
        RAISE EXCEPTION 'oidc_client_id and oidc_project_id must differ: they register different audiences';
    END IF;

    IF v_tenant <> '' THEN
        IF v_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'tenant_id must be a UUID';
        END IF;
        v_tenant_id := v_tenant::uuid;
        -- An existing tenant keeps its name: the id is authoritative.
        INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
        VALUES (v_tenant_id, v_name, 'shared', now())
        ON CONFLICT (tenant_id) DO NOTHING;
    ELSE
        SELECT count(*), min(tenant_id::text)::uuid INTO v_matches, v_tenant_id
          FROM tenant WHERE name = v_name;
        IF v_matches > 1 THEN
            RAISE EXCEPTION 'more than one tenant is named %; pass tenant_id', v_name;
        ELSIF v_matches = 0 THEN
            v_tenant_id := gen_random_uuid();
            INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
            VALUES (v_tenant_id, v_name, 'shared', now());
        END IF;
    END IF;

    -- Browser sign-in (JIT on) and machine tokens (JIT off) resolve through the same exact
    -- issuer/audience lookup. (issuer, audience) is unique across tenants, so a conflict owned by
    -- another tenant updates nothing and is refused below.
    FOREACH v_audience IN ARRAY ARRAY[v_client, v_project] LOOP
        v_jit := v_audience = v_client;
        INSERT INTO identity_provider
            (provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms, enabled,
             jit_provisioning_enabled, userinfo_uri)
        VALUES
            (gen_random_uuid(), v_tenant_id, v_issuer, v_audience, v_issuer || '/oauth/v2/keys',
             ARRAY['RS256']::text[], true, v_jit, v_issuer || '/oidc/v1/userinfo')
        -- A row this tenant already has is left exactly as it is: a re-run must never re-enable a
        -- provider or turn JIT back on after an operator changed it. The no-op update only counts it.
        ON CONFLICT (issuer, audience) DO UPDATE
        SET tenant_id = identity_provider.tenant_id
        WHERE identity_provider.tenant_id = EXCLUDED.tenant_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'issuer % with audience % is already registered to another tenant',
                v_issuer, v_audience;
        END IF;
    END LOOP;

    RAISE NOTICE 'identity bootstrap complete: tenant % (%), audiences % (jit) and % (machine)',
        v_name, v_tenant_id, v_client, v_project;
END
$$;
COMMIT;
