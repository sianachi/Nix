namespace Nix.Persistence.Migrations;

/// <summary>RLS, least-privilege grants, and exact worker functions for the plugin event runtime.</summary>
public static class PluginEventRuntimeSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Hardens plugin tables and installs the cross-tenant worker boundary.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            ALTER TABLE plugin_publisher
                ADD CONSTRAINT ck_plugin_publisher_key CHECK (octet_length(ed25519_public_key) = 32),
                ADD CONSTRAINT ck_plugin_publisher_id CHECK (publisher_id ~ '^[a-z0-9][a-z0-9.-]{1,126}[a-z0-9]$' AND publisher_id LIKE '%.%');
            ALTER TABLE plugin_component
                ADD CONSTRAINT ck_plugin_component_identity CHECK (
                    component_id LIKE publisher_id || '/%' AND
                    component_id ~ '^[a-z0-9][a-z0-9.-]{1,126}[a-z0-9]/[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$'),
                ADD CONSTRAINT ck_plugin_component_version CHECK (component_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'),
                ADD CONSTRAINT ck_plugin_component_sha256 CHECK (sha256 ~ '^[0-9A-F]{64}$'),
                ADD CONSTRAINT ck_plugin_component_size CHECK (byte_length BETWEEN 1 AND 8388608),
                ADD CONSTRAINT ck_plugin_component_signature CHECK (octet_length(ed25519_signature) = 64),
                ADD CONSTRAINT ck_plugin_component_object_key CHECK (
                    object_key = 'plugins/components/' || tenant_id::text || '/' || publisher_id || '/' ||
                        substring(component_id FROM char_length(publisher_id) + 2) || '/' ||
                        component_version || '/' || sha256 || '.wasm');
            ALTER TABLE plugin_capability_grant
                ADD CONSTRAINT ck_plugin_capability_grant_closed CHECK (capability = 'items.read-metadata');
            ALTER TABLE plugin_event_receipt
                ADD CONSTRAINT ck_plugin_event_receipt_kind CHECK (kind ~ '^[a-z][a-z0-9._-]{1,63}$' AND kind LIKE '%.%'),
                ADD CONSTRAINT ck_plugin_event_receipt_version CHECK (aggregate_version IS NULL OR aggregate_version > 0),
                ADD CONSTRAINT ck_plugin_event_receipt_causation CHECK (
                    causation_depth BETWEEN 0 AND 4 AND
                    (causation_depth <> 0 OR causation_id = event_id));
            ALTER TABLE plugin_event_inbox
                ADD CONSTRAINT ck_plugin_event_inbox_status CHECK (status IN ('pending', 'running', 'completed', 'failed')),
                ADD CONSTRAINT ck_plugin_event_inbox_attempts CHECK (attempts BETWEEN 0 AND 5),
                ADD CONSTRAINT ck_plugin_event_inbox_causation CHECK (causation_depth BETWEEN 0 AND 4);
            ALTER TABLE plugin_invocation
                ADD CONSTRAINT ck_plugin_invocation_status CHECK (status IN ('running', 'completed', 'failed')),
                ADD CONSTRAINT ck_plugin_invocation_attempt CHECK (attempt BETWEEN 1 AND 5),
                ADD CONSTRAINT ck_plugin_invocation_causation CHECK (causation_depth BETWEEN 0 AND 4),
                ADD CONSTRAINT ck_plugin_invocation_fingerprint CHECK (completion_fingerprint IS NULL OR octet_length(completion_fingerprint) = 32);

            ALTER TABLE plugin_publisher ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_publisher FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_publisher_tenant_isolation ON plugin_publisher
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_component ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_component FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_component_tenant_isolation ON plugin_component
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_installation ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_installation FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_installation_tenant_isolation ON plugin_installation
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_capability_grant ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_capability_grant FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_capability_grant_tenant_isolation ON plugin_capability_grant
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_event_receipt ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_event_receipt FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_event_receipt_tenant_isolation ON plugin_event_receipt
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_event_inbox ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_event_inbox FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_event_inbox_tenant_isolation ON plugin_event_inbox
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);
            ALTER TABLE plugin_invocation ENABLE ROW LEVEL SECURITY;
            ALTER TABLE plugin_invocation FORCE ROW LEVEL SECURITY;
            CREATE POLICY plugin_invocation_tenant_isolation ON plugin_invocation
                USING (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = nullif(current_setting('nix.tenant_id', true), '')::uuid);

            REVOKE ALL ON plugin_publisher, plugin_component, plugin_installation,
                plugin_capability_grant, plugin_event_receipt, plugin_event_inbox, plugin_invocation
                FROM {{ApplicationRole}};
            GRANT INSERT, SELECT ON plugin_publisher, plugin_component TO {{ApplicationRole}};
            GRANT INSERT, SELECT ON plugin_installation TO {{ApplicationRole}};
            GRANT UPDATE (enabled, updated_at) ON plugin_installation TO {{ApplicationRole}};
            GRANT DELETE, INSERT, SELECT ON plugin_capability_grant TO {{ApplicationRole}};
            GRANT SELECT ON plugin_event_receipt, plugin_event_inbox, plugin_invocation TO {{ApplicationRole}};

            CREATE OR REPLACE FUNCTION nix_prepare_plugin_event(
                p_event_id uuid,
                p_tenant_id uuid,
                p_workspace_id uuid,
                p_item_id uuid,
                p_kind text,
                p_aggregate_version bigint,
                p_causation_id uuid,
                p_causation_depth integer,
                p_lease_seconds integer)
            RETURNS TABLE (
                outcome text,
                invocation_id uuid,
                installation_id uuid,
                publisher_id text,
                component_id text,
                component_version text,
                object_key text,
                sha256 text,
                byte_length bigint,
                public_key bytea,
                signature bytea,
                capabilities text[],
                attempt integer,
                lease_until timestamptz,
                workspace_id uuid,
                item_id uuid,
                event_kind text,
                aggregate_version bigint,
                causation_id uuid,
                causation_depth integer)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                receipt plugin_event_receipt%ROWTYPE;
                candidate record;
                next_invocation uuid;
                next_attempt integer;
                next_lease timestamptz;
                emitted boolean := false;
            BEGIN
                IF p_event_id IS NULL OR p_event_id = '00000000-0000-0000-0000-000000000000'::uuid
                    OR p_tenant_id IS NULL OR p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
                    OR p_workspace_id IS NULL OR p_workspace_id = '00000000-0000-0000-0000-000000000000'::uuid
                    OR p_kind IS NULL OR p_kind !~ '^[a-z][a-z0-9._-]{1,63}$' OR p_kind NOT LIKE '%.%'
                    OR p_aggregate_version <= 0
                    OR p_causation_id IS NULL OR p_causation_id = '00000000-0000-0000-0000-000000000000'::uuid
                    OR p_causation_depth <> 0
                    OR p_causation_id <> p_event_id
                    OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM workspace AS exact_workspace
                     WHERE exact_workspace.tenant_id = p_tenant_id
                       AND exact_workspace.workspace_id = p_workspace_id) THEN
                    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;

                -- RabbitMQ carries only a notification. The durable outbox row is the authority;
                -- a compromised worker credential cannot fabricate a cross-tenant event identity.
                IF NOT EXISTS (
                    SELECT 1 FROM worker_outbox_event AS source_event
                     WHERE source_event.event_id = p_event_id) THEN
                    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM worker_outbox_event AS source_event
                     WHERE source_event.event_id = p_event_id
                       AND source_event.tenant_id = p_tenant_id
                       AND source_event.workspace_id IS NOT DISTINCT FROM p_workspace_id
                       AND source_event.item_id IS NOT DISTINCT FROM p_item_id
                       AND source_event.kind = p_kind
                       AND source_event.aggregate_version IS NOT DISTINCT FROM p_aggregate_version) THEN
                    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;

                INSERT INTO plugin_event_receipt
                    (tenant_id, event_id, workspace_id, kind, item_id, aggregate_version,
                     causation_id, causation_depth, received_at)
                VALUES
                    (p_tenant_id, p_event_id, p_workspace_id, p_kind, p_item_id,
                     p_aggregate_version, p_causation_id, p_causation_depth, clock_timestamp())
                ON CONFLICT (tenant_id, event_id) DO NOTHING;

                SELECT exact_receipt.* INTO receipt
                  FROM plugin_event_receipt AS exact_receipt
                 WHERE exact_receipt.tenant_id = p_tenant_id
                   AND exact_receipt.event_id = p_event_id
                 FOR UPDATE;
                IF receipt.workspace_id IS DISTINCT FROM p_workspace_id
                    OR receipt.kind IS DISTINCT FROM p_kind
                    OR receipt.item_id IS DISTINCT FROM p_item_id
                    OR receipt.aggregate_version IS DISTINCT FROM p_aggregate_version
                    OR receipt.causation_id IS DISTINCT FROM p_causation_id
                    OR receipt.causation_depth IS DISTINCT FROM p_causation_depth THEN
                    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;

                UPDATE plugin_invocation AS expired
                   SET status = 'failed', succeeded = false, retryable = true,
                       error_code = 'plugin_lease_expired',
                       error_detail = 'The plugin invocation lease expired before completion.',
                       completed_at = clock_timestamp()
                  FROM plugin_event_inbox AS inbox
                 WHERE inbox.tenant_id = p_tenant_id AND inbox.event_id = p_event_id
                   AND inbox.current_invocation_id = expired.invocation_id
                   AND inbox.status = 'running' AND expired.status = 'running'
                   AND expired.lease_until <= clock_timestamp();

                UPDATE plugin_event_inbox AS inbox
                   SET status = CASE WHEN inbox.attempts < 5 THEN 'pending' ELSE 'failed' END,
                       error_code = CASE WHEN inbox.attempts < 5 THEN NULL ELSE 'plugin_attempts_exhausted' END,
                       error_detail = CASE WHEN inbox.attempts < 5 THEN NULL ELSE 'The plugin exhausted its five attempts.' END,
                       completed_at = CASE WHEN inbox.attempts < 5 THEN NULL ELSE clock_timestamp() END,
                       updated_at = clock_timestamp()
                  FROM plugin_invocation AS expired
                 WHERE inbox.tenant_id = p_tenant_id AND inbox.event_id = p_event_id
                   AND inbox.current_invocation_id = expired.invocation_id
                   AND inbox.status = 'running' AND expired.status = 'failed'
                   AND expired.error_code = 'plugin_lease_expired';

                INSERT INTO plugin_event_inbox
                    (tenant_id, event_id, installation_id, workspace_id, kind, item_id,
                     aggregate_version, causation_id, causation_depth, status, attempts,
                     current_invocation_id, error_code, error_detail, created_at, updated_at,
                     completed_at)
                SELECT p_tenant_id, p_event_id, enabled.installation_id, p_workspace_id, p_kind,
                       p_item_id, p_aggregate_version, p_causation_id, p_causation_depth,
                       'pending', 0, NULL, NULL, NULL, clock_timestamp(), clock_timestamp(), NULL
                  FROM plugin_installation AS enabled
                 WHERE enabled.tenant_id = p_tenant_id
                   AND enabled.workspace_id = p_workspace_id
                   AND enabled.enabled = true
                ON CONFLICT ON CONSTRAINT "PK_plugin_event_inbox" DO NOTHING;

                IF EXISTS (
                    SELECT 1
                      FROM plugin_event_inbox AS active
                      JOIN plugin_invocation AS current
                        ON current.invocation_id = active.current_invocation_id
                     WHERE active.tenant_id = p_tenant_id AND active.event_id = p_event_id
                       AND active.status = 'running' AND current.status = 'running'
                       AND current.lease_until > clock_timestamp()) THEN
                    RETURN QUERY SELECT 'busy'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                    RETURN;
                END IF;

                FOR candidate IN
                    SELECT inbox.installation_id AS target_installation_id,
                           inbox.attempts AS prior_attempts,
                           installation.component_id AS target_component_id,
                           installation.component_version AS target_component_version,
                           component.publisher_id AS target_publisher_id,
                           component.object_key AS target_object_key,
                           component.sha256 AS target_sha256,
                           component.byte_length AS target_byte_length,
                           component.ed25519_signature AS target_signature,
                           publisher.ed25519_public_key AS target_public_key,
                           COALESCE((SELECT array_agg(grant_row.capability ORDER BY grant_row.capability)
                                     FROM plugin_capability_grant AS grant_row
                                    WHERE grant_row.tenant_id = inbox.tenant_id
                                      AND grant_row.installation_id = inbox.installation_id), ARRAY[]::text[]) AS target_capabilities
                      FROM plugin_event_inbox AS inbox
                      JOIN plugin_installation AS installation
                        ON installation.tenant_id = inbox.tenant_id
                       AND installation.installation_id = inbox.installation_id
                       AND installation.enabled = true
                      JOIN plugin_component AS component
                        ON component.tenant_id = installation.tenant_id
                       AND component.component_id = installation.component_id
                       AND component.component_version = installation.component_version
                      JOIN plugin_publisher AS publisher
                        ON publisher.tenant_id = component.tenant_id
                       AND publisher.publisher_id = component.publisher_id
                     WHERE inbox.tenant_id = p_tenant_id AND inbox.event_id = p_event_id
                       AND inbox.status = 'pending' AND inbox.attempts < 5
                     ORDER BY inbox.installation_id
                     FOR UPDATE OF inbox
                LOOP
                    next_invocation := gen_random_uuid();
                    next_attempt := candidate.prior_attempts + 1;
                    next_lease := clock_timestamp() + make_interval(secs => p_lease_seconds);
                    UPDATE plugin_event_inbox AS claimed
                       SET status = 'running', attempts = next_attempt,
                           current_invocation_id = next_invocation, error_code = NULL,
                           error_detail = NULL, completed_at = NULL, updated_at = clock_timestamp()
                     WHERE claimed.tenant_id = p_tenant_id AND claimed.event_id = p_event_id
                       AND claimed.installation_id = candidate.target_installation_id;
                    INSERT INTO plugin_invocation
                        (invocation_id, tenant_id, event_id, installation_id, workspace_id,
                         attempt, causation_id, causation_depth, status, lease_until,
                         created_at, completed_at)
                    VALUES
                        (next_invocation, p_tenant_id, p_event_id,
                         candidate.target_installation_id, p_workspace_id, next_attempt,
                         p_causation_id, p_causation_depth, 'running', next_lease,
                         clock_timestamp(), NULL);
                    emitted := true;
                    RETURN QUERY SELECT 'prepared'::text, next_invocation,
                        candidate.target_installation_id, candidate.target_publisher_id::text,
                        candidate.target_component_id::text, candidate.target_component_version::text,
                        candidate.target_object_key::text, candidate.target_sha256::text,
                        candidate.target_byte_length, candidate.target_public_key,
                        candidate.target_signature, candidate.target_capabilities::text[], next_attempt,
                        next_lease, p_workspace_id, p_item_id, p_kind, p_aggregate_version,
                        p_causation_id, p_causation_depth;
                END LOOP;

                IF NOT emitted THEN
                    RETURN QUERY SELECT 'settled'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea,
                        NULL::bytea, NULL::text[], NULL::integer, NULL::timestamptz, NULL::uuid,
                        NULL::uuid, NULL::text, NULL::bigint, NULL::uuid, NULL::integer;
                END IF;
            END
            $function$;

            CREATE OR REPLACE FUNCTION nix_plugin_read_item_metadata(
                p_invocation_id uuid,
                p_item_id uuid)
            RETURNS TABLE (
                item_id uuid,
                workspace_id uuid,
                parent_id uuid,
                item_type text,
                title text,
                lifecycle_state text,
                last_modified_at timestamptz,
                causation_id uuid,
                causation_depth integer)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                SELECT target.id,
                       target.workspace_id,
                       target.parent_id,
                       target.type,
                       left(target.properties ->> 'title', 512),
                       target.lifecycle_state,
                       target.last_modified_at,
                       invocation.causation_id,
                       invocation.causation_depth
                  FROM plugin_invocation AS invocation
                  JOIN plugin_event_inbox AS inbox
                    ON inbox.tenant_id = invocation.tenant_id
                   AND inbox.event_id = invocation.event_id
                   AND inbox.installation_id = invocation.installation_id
                   AND inbox.current_invocation_id = invocation.invocation_id
                   AND inbox.status = 'running'
                  JOIN plugin_installation AS installation
                    ON installation.tenant_id = invocation.tenant_id
                   AND installation.installation_id = invocation.installation_id
                   AND installation.enabled = true
                  JOIN plugin_capability_grant AS grant_row
                    ON grant_row.tenant_id = invocation.tenant_id
                   AND grant_row.installation_id = invocation.installation_id
                   AND grant_row.capability = 'items.read-metadata'
                  JOIN item AS target
                    ON target.tenant_id = invocation.tenant_id
                   AND target.workspace_id = invocation.workspace_id
                   AND target.id = p_item_id
                 WHERE invocation.invocation_id = p_invocation_id
                   AND invocation.status = 'running'
                   AND invocation.lease_until > clock_timestamp()
                   AND invocation.causation_depth BETWEEN 0 AND 4
                 LIMIT 1
            $function$;

            CREATE OR REPLACE FUNCTION nix_complete_plugin_invocation(
                p_invocation_id uuid,
                p_succeeded boolean,
                p_retryable boolean,
                p_error_code text,
                p_error_detail text,
                p_fingerprint bytea)
            RETURNS TABLE (outcome text, should_requeue boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                invocation plugin_invocation%ROWTYPE;
                requeue boolean;
            BEGIN
                IF p_invocation_id IS NULL OR octet_length(p_fingerprint) <> 32
                    OR (p_succeeded AND (p_retryable OR p_error_code IS NOT NULL OR p_error_detail IS NOT NULL))
                    OR (NOT p_succeeded AND (p_error_code IS NULL OR p_error_detail IS NULL
                        OR char_length(p_error_code) NOT BETWEEN 1 AND 64
                        OR char_length(p_error_detail) NOT BETWEEN 1 AND 2000)) THEN
                    RETURN QUERY SELECT 'invalid'::text, false;
                    RETURN;
                END IF;
                SELECT exact_invocation.* INTO invocation
                  FROM plugin_invocation AS exact_invocation
                 WHERE exact_invocation.invocation_id = p_invocation_id
                 FOR UPDATE;
                IF NOT FOUND THEN
                    RETURN QUERY SELECT 'not_found'::text, false;
                    RETURN;
                END IF;
                IF invocation.completion_fingerprint IS NOT NULL THEN
                    IF invocation.completion_fingerprint = p_fingerprint THEN
                        RETURN QUERY SELECT 'replayed'::text,
                            COALESCE(invocation.retryable, false) AND invocation.attempt < 5;
                    ELSE
                        RETURN QUERY SELECT 'conflict'::text, false;
                    END IF;
                    RETURN;
                END IF;
                IF invocation.status <> 'running' OR invocation.lease_until <= clock_timestamp()
                    OR NOT EXISTS (
                        SELECT 1 FROM plugin_event_inbox AS current_inbox
                         WHERE current_inbox.tenant_id = invocation.tenant_id
                           AND current_inbox.event_id = invocation.event_id
                           AND current_inbox.installation_id = invocation.installation_id
                           AND current_inbox.current_invocation_id = invocation.invocation_id
                           AND current_inbox.status = 'running') THEN
                    RETURN QUERY SELECT 'conflict'::text, false;
                    RETURN;
                END IF;
                requeue := NOT p_succeeded AND p_retryable AND invocation.attempt < 5;
                UPDATE plugin_invocation AS completed
                   SET status = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END,
                       completion_fingerprint = p_fingerprint,
                       succeeded = p_succeeded,
                       retryable = p_retryable,
                       error_code = p_error_code,
                       error_detail = p_error_detail,
                       completed_at = clock_timestamp()
                 WHERE completed.invocation_id = p_invocation_id;
                UPDATE plugin_event_inbox AS inbox
                   SET status = CASE WHEN p_succeeded THEN 'completed'
                                     WHEN requeue THEN 'pending' ELSE 'failed' END,
                       error_code = p_error_code,
                       error_detail = p_error_detail,
                       completed_at = CASE WHEN requeue THEN NULL ELSE clock_timestamp() END,
                       updated_at = clock_timestamp()
                 WHERE inbox.tenant_id = invocation.tenant_id
                   AND inbox.event_id = invocation.event_id
                   AND inbox.installation_id = invocation.installation_id
                   AND inbox.current_invocation_id = invocation.invocation_id;
                RETURN QUERY SELECT 'applied'::text, requeue;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_prepare_plugin_event(uuid, uuid, uuid, uuid, text, bigint, uuid, integer, integer) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_plugin_read_item_metadata(uuid, uuid) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_complete_plugin_invocation(uuid, boolean, boolean, text, text, bytea) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_prepare_plugin_event(uuid, uuid, uuid, uuid, text, bigint, uuid, integer, integer) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_plugin_read_item_metadata(uuid, uuid) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_complete_plugin_invocation(uuid, boolean, boolean, text, text, bytea) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes worker functions before EF drops their backing tables.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_complete_plugin_invocation(uuid, boolean, boolean, text, text, bytea);
            DROP FUNCTION IF EXISTS nix_plugin_read_item_metadata(uuid, uuid);
            DROP FUNCTION IF EXISTS nix_prepare_plugin_event(uuid, uuid, uuid, uuid, text, bigint, uuid, integer, integer);
            """);
    }
}
