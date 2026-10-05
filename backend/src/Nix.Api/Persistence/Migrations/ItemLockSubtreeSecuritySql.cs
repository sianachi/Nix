namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for the migration that makes an item lock cover its subtree: the
/// collaboration service's read of the closure, the search index feed, and the re-index on lock.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it, like every other file of this kind: a later phase
/// writes its own equivalent rather than editing this one.
/// </remarks>
internal static class ItemLockSubtreeSecuritySql
{
    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        GrantClosureToCollaboration(emit);
        emit(SubtreeLockSearchIndexReaders);
        QueueSubtreeOnLock(emit);
    }

    /// <summary>Undoes <see cref="Apply"/>, restoring what <c>ItemLockSecuritySql</c> left.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP TRIGGER IF EXISTS item_lock_search_outbox ON item_lock;
            CREATE CONSTRAINT TRIGGER item_lock_search_outbox
                AFTER INSERT OR DELETE ON item_lock
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW
                EXECUTE FUNCTION nix_queue_body_search_event();
            DROP FUNCTION IF EXISTS nix_queue_lock_search_event();
            """);
        emit(OwnLockSearchIndexReaders);
        emit($"""
            REVOKE SELECT (tenant_id, descendant_id, ancestor_id) ON item_closure FROM {CollaborationRole};
            """);
    }

    /// <summary>
    /// Lets the collaboration service see which items sit under a lock, and nothing more of the tree.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The service reads bodies straight from the content tables for a subtree export, a template
    /// capture and an embedded section, and leaves locked ones out. A lock now covers its subtree,
    /// so "is this locked" means "is this or anything above it locked", which is a closure read.
    /// Without it an unlocked note that embeds a note inside a locked folder would export that
    /// note's body.
    /// </para>
    /// <para>
    /// Column-level, the shape the <c>item_lock</c> grant takes: the three columns the question
    /// needs, and the table's tenant policy still applies to every row.
    /// </para>
    /// </remarks>
    private static void GrantClosureToCollaboration(Action<string> emit) =>
        emit($"""
            GRANT SELECT (tenant_id, descendant_id, ancestor_id) ON item_closure TO {CollaborationRole};
            """);

    /// <summary>
    /// Re-indexes every item under a lock when the lock is placed or removed, not just the locked
    /// item, so the index drops - and later restores - the bodies the lock now covers.
    /// </summary>
    /// <remarks>
    /// The fan-out has the shape <c>nix_queue_permission_search_event</c> already uses for a
    /// permission change on a folder. Moves need nothing new: a reparent already re-indexes the
    /// moved subtree, and the readers below judge each item by its ancestors at that moment.
    /// Deferred like the other search triggers, so a rolled-back lock queues nothing.
    /// </remarks>
    private static void QueueSubtreeOnLock(Action<string> emit) =>
        emit("""
            CREATE FUNCTION nix_queue_lock_search_event()
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
                       'item.changed', '{}'::jsonb, clock_timestamp(), 0
                  FROM item_closure edge
                  JOIN item indexed
                    ON indexed.tenant_id = edge.tenant_id
                   AND indexed.id = edge.descendant_id
                 WHERE edge.tenant_id = changed_tenant
                   AND edge.ancestor_id = changed_item
                 ORDER BY indexed.id;
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                RETURN NEW;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_queue_lock_search_event() FROM PUBLIC;

            DROP TRIGGER IF EXISTS item_lock_search_outbox ON item_lock;
            CREATE CONSTRAINT TRIGGER item_lock_search_outbox
                AFTER INSERT OR DELETE ON item_lock
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW
                EXECUTE FUNCTION nix_queue_lock_search_event();
            """);

    /// <summary>
    /// The index feed's two readers, judging each item by its own lock and every ancestor's: the
    /// body reader returns no body, and the metadata reader no outgoing links, for an item under a
    /// lock. <c>CREATE OR REPLACE</c> keeps the signatures, owners and grants.
    /// </summary>
    private const string SubtreeLockSearchIndexReaders = """
        CREATE OR REPLACE FUNCTION nix_read_search_index_metadata(p_tenant_id uuid, p_item_id uuid)
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
                   CASE WHEN locked.item_id IS NOT NULL THEN ARRAY[]::uuid[] ELSE COALESCE((
                       SELECT array_agg(link.target_item_id ORDER BY link.target_item_id)
                         FROM item_link link
                        WHERE link.tenant_id = item.tenant_id
                          AND link.source_item_id = item.id
                   ), ARRAY[]::uuid[]) END,
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
              LEFT JOIN LATERAL (
                  SELECT lock_edge.ancestor_id AS item_id
                    FROM item_closure lock_edge
                    JOIN item_lock
                      ON item_lock.tenant_id = lock_edge.tenant_id
                     AND item_lock.item_id = lock_edge.ancestor_id
                   WHERE lock_edge.tenant_id = item.tenant_id
                     AND lock_edge.descendant_id = item.id
                   LIMIT 1
              ) AS locked ON TRUE
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

        CREATE OR REPLACE FUNCTION nix_read_search_index_body(p_tenant_id uuid, p_item_id uuid)
        RETURNS TABLE (found boolean, body_text text)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
            SELECT true, CASE WHEN locked.item_id IS NULL THEN search.body_text END
              FROM item
              LEFT JOIN item_search search
                ON search.tenant_id = item.tenant_id
               AND search.item_id = item.id
              LEFT JOIN LATERAL (
                  SELECT lock_edge.ancestor_id AS item_id
                    FROM item_closure lock_edge
                    JOIN item_lock
                      ON item_lock.tenant_id = lock_edge.tenant_id
                     AND item_lock.item_id = lock_edge.ancestor_id
                   WHERE lock_edge.tenant_id = item.tenant_id
                     AND lock_edge.descendant_id = item.id
                   LIMIT 1
              ) AS locked ON TRUE
             WHERE item.tenant_id = p_tenant_id
               AND item.id = p_item_id
        $function$;
        """;

    /// <summary>The readers exactly as <c>ItemLockSecuritySql</c> left them, for <see cref="Revert"/>.</summary>
    private const string OwnLockSearchIndexReaders = """
        CREATE OR REPLACE FUNCTION nix_read_search_index_metadata(p_tenant_id uuid, p_item_id uuid)
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
                   CASE WHEN locked.item_id IS NOT NULL THEN ARRAY[]::uuid[] ELSE COALESCE((
                       SELECT array_agg(link.target_item_id ORDER BY link.target_item_id)
                         FROM item_link link
                        WHERE link.tenant_id = item.tenant_id
                          AND link.source_item_id = item.id
                   ), ARRAY[]::uuid[]) END,
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
              LEFT JOIN item_lock locked
                ON locked.tenant_id = item.tenant_id
               AND locked.item_id = item.id
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

        CREATE OR REPLACE FUNCTION nix_read_search_index_body(p_tenant_id uuid, p_item_id uuid)
        RETURNS TABLE (found boolean, body_text text)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $function$
            SELECT true, CASE WHEN locked.item_id IS NULL THEN search.body_text END
              FROM item
              LEFT JOIN item_search search
                ON search.tenant_id = item.tenant_id
               AND search.item_id = item.id
              LEFT JOIN item_lock locked
                ON locked.tenant_id = item.tenant_id
               AND locked.item_id = item.id
             WHERE item.tenant_id = p_tenant_id
               AND item.id = p_item_id
        $function$;
        """;

}
