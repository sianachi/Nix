namespace Nix.Persistence.Migrations;

/// <summary>
/// Adds the compact, versioned workspace-event contract consumed by the RabbitMQ indexer.
/// </summary>
/// <remarks>
/// Search documents remain derived state. Postgres records only enough bounded plaintext and
/// metadata to rebuild them, while the Go worker receives identifiers over RabbitMQ and hydrates
/// the current projection through two exact security-definer reads.
/// </remarks>
public static class SearchIndexOutboxSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Applies the derived-text column, read functions, versioning, and change triggers.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            ALTER TABLE item_search
                ADD COLUMN body_text text NOT NULL DEFAULT '';

            ALTER TABLE item_search
                ADD CONSTRAINT item_search_body_text_bounded
                CHECK (octet_length(body_text) <= 2000000);

            -- Existing snapshots are derived from the same update log. Backfill only the bounded
            -- prefix Collaboration already feeds to Postgres search; the worker never needs an
            -- unbounded document to build a useful index.
            UPDATE item_search indexed
               SET body_text = left(latest.plaintext, 500000)
              FROM content_doc document
              JOIN LATERAL (
                    SELECT snapshot.plaintext
                      FROM content_snapshot snapshot
                     WHERE snapshot.tenant_id = document.tenant_id
                       AND snapshot.doc_id = document.doc_id
                     ORDER BY snapshot.seq DESC
                     LIMIT 1
              ) latest ON TRUE
             WHERE indexed.tenant_id = document.tenant_id
               AND indexed.item_id = document.item_id;

            CREATE SEQUENCE nix_search_index_version AS bigint;
            REVOKE ALL ON SEQUENCE nix_search_index_version FROM PUBLIC;
            REVOKE ALL ON SEQUENCE nix_search_index_version FROM nix_app;
            REVOKE ALL ON SEQUENCE nix_search_index_version FROM nix_collab;

            CREATE FUNCTION nix_assign_search_index_version()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF NEW.kind IN ('item.changed', 'item.deleted', 'permission.changed')
                   AND NEW.aggregate_version IS NULL THEN
                    NEW.aggregate_version := nextval('nix_search_index_version');
                END IF;
                RETURN NEW;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_assign_search_index_version() FROM PUBLIC;

            CREATE TRIGGER worker_outbox_search_version
                BEFORE INSERT ON worker_outbox_event
                FOR EACH ROW
                EXECUTE FUNCTION nix_assign_search_index_version();

            UPDATE worker_outbox_event
               SET aggregate_version = nextval('nix_search_index_version')
             WHERE kind IN ('item.changed', 'item.deleted', 'permission.changed')
               AND aggregate_version IS NULL;
            """);

        ReplaceOutboxLease(emit, includeAggregateVersion: true);
        AddProjectionReaders(emit);
        AddChangeTriggers(emit);
    }

    /// <summary>Removes this migration and restores the previous dispatch result shape.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP TRIGGER IF EXISTS acl_entry_search_outbox ON acl_entry;
            DROP TRIGGER IF EXISTS item_search_body_outbox ON item_search;
            DROP TRIGGER IF EXISTS item_search_metadata_outbox ON item;
            DROP TRIGGER IF EXISTS worker_outbox_search_version ON worker_outbox_event;
            DROP FUNCTION IF EXISTS nix_queue_permission_search_event();
            DROP FUNCTION IF EXISTS nix_queue_body_search_event();
            DROP FUNCTION IF EXISTS nix_queue_item_search_event();
            DROP FUNCTION IF EXISTS nix_assign_search_index_version();
            DROP FUNCTION IF EXISTS nix_search_index_outbox_status();
            DROP FUNCTION IF EXISTS nix_enqueue_search_rebuild_page(uuid, uuid, timestamptz, integer);
            DROP FUNCTION IF EXISTS nix_read_search_index_body(uuid, uuid);
            DROP FUNCTION IF EXISTS nix_read_search_index_metadata(uuid, uuid);
            """);

        ReplaceOutboxLease(emit, includeAggregateVersion: false);

        emit("""
            DROP SEQUENCE IF EXISTS nix_search_index_version;
            ALTER TABLE item_search DROP CONSTRAINT IF EXISTS item_search_body_text_bounded;
            ALTER TABLE item_search DROP COLUMN IF EXISTS body_text;
            """);
    }

    private static void ReplaceOutboxLease(Action<string> emit, bool includeAggregateVersion)
    {
        var extraReturn = includeAggregateVersion ? ",\n                aggregate_version bigint" : string.Empty;
        var extraValue = includeAggregateVersion ? ",\n                          leased.aggregate_version" : string.Empty;
        emit($$"""
            DROP FUNCTION IF EXISTS nix_lease_worker_outbox(text, text, integer, integer);

            CREATE FUNCTION nix_lease_worker_outbox(
                p_kind text,
                p_owner text,
                p_limit integer,
                p_lease_seconds integer)
            RETURNS TABLE (
                event_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                item_id uuid,
                kind text,
                payload jsonb,
                attempts integer,
                available_at timestamptz{{extraReturn}})
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_limit NOT BETWEEN 1 AND 100
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker outbox lease request';
                END IF;

                RETURN QUERY
                WITH candidates AS (
                    SELECT queued.event_id
                      FROM worker_outbox_event queued
                     WHERE (p_kind IS NULL OR queued.kind = p_kind)
                       AND queued.processed_at IS NULL
                       AND queued.available_at <= clock_timestamp()
                       AND (queued.lease_until IS NULL OR queued.lease_until < clock_timestamp())
                     ORDER BY queued.available_at, queued.event_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT p_limit
                )
                UPDATE worker_outbox_event leased
                   SET attempts = leased.attempts + 1,
                       lease_owner = p_owner,
                       lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
                  FROM candidates
                 WHERE leased.event_id = candidates.event_id
                RETURNING leased.event_id,
                          leased.tenant_id,
                          leased.workspace_id,
                          leased.item_id,
                          leased.kind::text,
                          leased.payload,
                          leased.attempts,
                          leased.available_at{{extraValue}};
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_lease_worker_outbox(text, text, integer, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_worker_outbox(text, text, integer, integer) TO {{ApplicationRole}};
            """);
    }

    private static void AddProjectionReaders(Action<string> emit) => emit($$"""
        CREATE FUNCTION nix_read_search_index_metadata(p_tenant_id uuid, p_item_id uuid)
        RETURNS TABLE (
            tenant_id uuid,
            workspace_id uuid,
            item_id uuid,
            parent_id uuid,
            item_type text,
            title text,
            property_text text,
            properties jsonb,
            ancestor_ids uuid[],
            links uuid[],
            authorization_keys text[],
            lifecycle_state text,
            indexable boolean,
            source_updated_at timestamptz)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
            SELECT item.tenant_id,
                   item.workspace_id,
                   item.id,
                   item.parent_id,
                   item.type,
                   item.properties ->> 'title',
                   concat_ws(' ', item.properties::text, file.file_name, file.media_type),
                   COALESCE(item.properties, '{}'::jsonb),
                   COALESCE((
                       SELECT array_agg(edge.ancestor_id ORDER BY edge.depth DESC, edge.ancestor_id)
                         FROM item_closure edge
                        WHERE edge.tenant_id = item.tenant_id
                          AND edge.descendant_id = item.id
                          AND edge.depth > 0
                   ), ARRAY[]::uuid[]),
                   COALESCE((
                       SELECT array_agg(link.target_item_id ORDER BY link.target_item_id)
                         FROM item_link link
                        WHERE link.tenant_id = item.tenant_id
                          AND link.source_item_id = item.id
                   ), ARRAY[]::uuid[]),
                   ARRAY['workspace:' || item.workspace_id::text],
                   item.lifecycle_state,
                   item.lifecycle_state = 'active'
                       AND item.template_id IS NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM item_closure visibility_edge
                             JOIN item visibility_ancestor
                               ON visibility_ancestor.tenant_id = visibility_edge.tenant_id
                              AND visibility_ancestor.id = visibility_edge.ancestor_id
                            WHERE visibility_edge.tenant_id = item.tenant_id
                              AND visibility_edge.descendant_id = item.id
                              AND visibility_edge.depth > 0
                              AND (visibility_ancestor.lifecycle_state IS DISTINCT FROM 'active'
                                   OR visibility_ancestor.template_id IS NOT NULL)
                       ),
                   GREATEST(item.last_modified_at, COALESCE(search.updated_at, item.last_modified_at))
              FROM item
              LEFT JOIN item_search search
                ON search.tenant_id = item.tenant_id
               AND search.item_id = item.id
              LEFT JOIN file_body body
                ON body.tenant_id = item.tenant_id
               AND body.item_id = item.id
              LEFT JOIN file_version file
                ON file.tenant_id = body.tenant_id
               AND file.item_id = body.item_id
               AND file.file_version_id = body.current_version_id
             WHERE item.tenant_id = p_tenant_id
               AND item.id = p_item_id
        $function$;

        CREATE FUNCTION nix_read_search_index_body(p_tenant_id uuid, p_item_id uuid)
        RETURNS TABLE (found boolean, body_text text)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
            SELECT true, search.body_text
              FROM item
              LEFT JOIN item_search search
                ON search.tenant_id = item.tenant_id
               AND search.item_id = item.id
             WHERE item.tenant_id = p_tenant_id
               AND item.id = p_item_id
        $function$;

        REVOKE ALL ON FUNCTION nix_read_search_index_metadata(uuid, uuid) FROM PUBLIC;
        REVOKE ALL ON FUNCTION nix_read_search_index_body(uuid, uuid) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_read_search_index_metadata(uuid, uuid) TO {{ApplicationRole}};
        GRANT EXECUTE ON FUNCTION nix_read_search_index_body(uuid, uuid) TO {{ApplicationRole}};

        CREATE FUNCTION nix_enqueue_search_rebuild_page(
            p_after_tenant_id uuid,
            p_after_item_id uuid,
            p_updated_since timestamptz,
            p_limit integer)
        RETURNS TABLE (
            enqueued integer,
            next_tenant_id uuid,
            next_item_id uuid,
            has_more boolean)
        LANGUAGE plpgsql
        VOLATILE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
        BEGIN
            IF p_limit NOT BETWEEN 1 AND 1000
               OR ((p_after_tenant_id IS NULL) <> (p_after_item_id IS NULL)) THEN
                RAISE EXCEPTION 'invalid search rebuild page request';
            END IF;

            RETURN QUERY
            WITH candidates AS MATERIALIZED (
                SELECT item.tenant_id, item.workspace_id, item.id
                  FROM item
                  LEFT JOIN item_search search
                    ON search.tenant_id = item.tenant_id
                   AND search.item_id = item.id
                 WHERE (p_after_tenant_id IS NULL
                        OR (item.tenant_id, item.id) > (p_after_tenant_id, p_after_item_id))
                   AND (p_updated_since IS NULL
                        OR GREATEST(item.last_modified_at,
                                   COALESCE(search.updated_at, item.last_modified_at)) >= p_updated_since)
                 ORDER BY item.tenant_id, item.id
                 LIMIT p_limit + 1
            ), page AS MATERIALIZED (
                SELECT candidate.tenant_id, candidate.workspace_id, candidate.id
                  FROM candidates candidate
                 ORDER BY candidate.tenant_id, candidate.id
                 LIMIT p_limit
            ), queued AS (
                INSERT INTO worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                SELECT gen_random_uuid(), page.tenant_id, page.workspace_id, page.id,
                       'item.changed', '{}'::jsonb, clock_timestamp(), 0
                  FROM page
                 ORDER BY page.tenant_id, page.id
                RETURNING tenant_id, item_id
            )
            SELECT count(queued.item_id)::integer,
                   (SELECT page.tenant_id FROM page ORDER BY page.tenant_id DESC, page.id DESC LIMIT 1),
                   (SELECT page.id FROM page ORDER BY page.tenant_id DESC, page.id DESC LIMIT 1),
                   (SELECT count(*) > p_limit FROM candidates)
              FROM queued;
        END
        $function$;

        CREATE FUNCTION nix_search_index_outbox_status()
        RETURNS TABLE (
            pending bigint,
            oldest_available_at timestamptz,
            highest_attempts integer,
            pending_failures bigint)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
            SELECT count(*),
                   min(event.available_at),
                   COALESCE(max(event.attempts), 0),
                   count(*) FILTER (WHERE event.last_error IS NOT NULL)
              FROM worker_outbox_event event
             WHERE event.kind IN ('item.changed', 'item.deleted', 'permission.changed')
               AND event.processed_at IS NULL
        $function$;

        REVOKE ALL ON FUNCTION nix_enqueue_search_rebuild_page(uuid, uuid, timestamptz, integer) FROM PUBLIC;
        REVOKE ALL ON FUNCTION nix_search_index_outbox_status() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_enqueue_search_rebuild_page(uuid, uuid, timestamptz, integer) TO {{ApplicationRole}};
        GRANT EXECUTE ON FUNCTION nix_search_index_outbox_status() TO {{ApplicationRole}};
        """);

    private static void AddChangeTriggers(Action<string> emit) => emit("""
        CREATE FUNCTION nix_queue_item_search_event()
        RETURNS trigger
        LANGUAGE plpgsql
        VOLATILE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
        DECLARE
            changed_id uuid;
            changed_tenant uuid;
            changed_workspace uuid;
            fan_out boolean;
        BEGIN
            IF TG_OP = 'DELETE' THEN
                INSERT INTO worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                VALUES (
                    gen_random_uuid(), OLD.tenant_id, OLD.workspace_id, OLD.id,
                    'item.deleted', '{}'::jsonb, clock_timestamp(), 0);
                RETURN OLD;
            END IF;

            changed_id := NEW.id;
            changed_tenant := NEW.tenant_id;
            changed_workspace := NEW.workspace_id;
            IF TG_OP = 'INSERT' THEN
                -- Every newly inserted descendant receives its own deferred event. Fan-out here
                -- would duplicate every child during atomic subtree publication. Avoid a lookup
                -- as well: large imports can insert tens of thousands of rows in one transaction.
                INSERT INTO worker_outbox_event (
                    event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
                VALUES (
                    gen_random_uuid(), changed_tenant, changed_workspace, changed_id,
                    'item.changed', '{}'::jsonb, clock_timestamp(), 0);
                RETURN NEW;
            END IF;

            fan_out := OLD.parent_id IS DISTINCT FROM NEW.parent_id
                OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
                OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                OR OLD.template_id IS DISTINCT FROM NEW.template_id;

            INSERT INTO worker_outbox_event (
                event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
            SELECT gen_random_uuid(), indexed.tenant_id, indexed.workspace_id, indexed.id,
                   'item.changed', '{}'::jsonb, clock_timestamp(), 0
              FROM item indexed
             WHERE indexed.tenant_id = changed_tenant
               AND (
                    indexed.id = changed_id
                    OR (fan_out AND EXISTS (
                        SELECT 1
                          FROM item_closure edge
                         WHERE edge.tenant_id = changed_tenant
                           AND edge.ancestor_id = changed_id
                           AND edge.descendant_id = indexed.id
                           AND edge.depth > 0)))
             ORDER BY indexed.id;
            RETURN NEW;
        END
        $function$;

        CREATE FUNCTION nix_queue_body_search_event()
        RETURNS trigger
        LANGUAGE plpgsql
        VOLATILE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
        DECLARE
            changed_tenant uuid;
            changed_item uuid;
        BEGIN
            changed_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
            changed_item := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;

            INSERT INTO worker_outbox_event (
                event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
            SELECT gen_random_uuid(), item.tenant_id, item.workspace_id, item.id,
                   'item.changed', '{}'::jsonb, clock_timestamp(), 0
              FROM item
             WHERE item.tenant_id = changed_tenant
               AND item.id = changed_item;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END
        $function$;

        CREATE FUNCTION nix_queue_permission_search_event()
        RETURNS trigger
        LANGUAGE plpgsql
        VOLATILE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
        DECLARE
            changed_tenant uuid;
            changed_item uuid;
        BEGIN
            changed_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
            changed_item := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;

            INSERT INTO worker_outbox_event (
                event_id, tenant_id, workspace_id, item_id, kind, payload, available_at, attempts)
            SELECT gen_random_uuid(), indexed.tenant_id, indexed.workspace_id, indexed.id,
                   'permission.changed', '{}'::jsonb, clock_timestamp(), 0
              FROM item indexed
             WHERE indexed.tenant_id = changed_tenant
               AND (indexed.id = changed_item OR EXISTS (
                    SELECT 1
                      FROM item_closure edge
                     WHERE edge.tenant_id = changed_tenant
                       AND edge.ancestor_id = changed_item
                       AND edge.descendant_id = indexed.id
                       AND edge.depth > 0))
             ORDER BY indexed.id;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END
        $function$;

        REVOKE ALL ON FUNCTION nix_queue_item_search_event() FROM PUBLIC;
        REVOKE ALL ON FUNCTION nix_queue_body_search_event() FROM PUBLIC;
        REVOKE ALL ON FUNCTION nix_queue_permission_search_event() FROM PUBLIC;

        CREATE CONSTRAINT TRIGGER item_search_metadata_outbox
            AFTER INSERT OR UPDATE OR DELETE ON item
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW
            EXECUTE FUNCTION nix_queue_item_search_event();

        CREATE CONSTRAINT TRIGGER item_search_body_outbox
            AFTER INSERT OR UPDATE OR DELETE ON item_search
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW
            EXECUTE FUNCTION nix_queue_body_search_event();

        CREATE CONSTRAINT TRIGGER acl_entry_search_outbox
            AFTER INSERT OR UPDATE OR DELETE ON acl_entry
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW
            EXECUTE FUNCTION nix_queue_permission_search_event();
        """);
}
