namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for <c>item_lock</c> and <c>item_unlock</c>: tenant isolation, the
/// grant split, and the bounds on what a row may hold.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it, like every other file of this kind: a later phase
/// writes its own equivalent rather than editing this one.
/// </remarks>
internal static class ItemLockSecuritySql
{
    /// <summary>The runtime role the API connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        Protect(emit, "item_lock");
        Protect(emit, "item_unlock");
        SplitGrants(emit);
        Bound(emit);
        WithholdFromSearchIndex(emit);
    }

    /// <summary>Undoes <see cref="WithholdFromSearchIndex"/>; the tables go with the generated Down.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP TRIGGER IF EXISTS item_lock_search_outbox ON item_lock;
            """);
        emit(OriginalSearchIndexReaders);
    }

    /// <summary>
    /// Puts the tenant isolation policy on one table.
    /// </summary>
    /// <remarks>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the owner is subject to it too.
    /// </remarks>
    private static void Protect(Action<string> emit, string table) =>
        emit($"""
            ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
            CREATE POLICY {table}_tenant_isolation ON {table}
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Full DML for Core; for the collaboration service, which items are locked and nothing more.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The collaboration service reads bodies straight from the content tables for a subtree
    /// export and a template capture, below the item Core authorized. It has to know which of
    /// those items are locked so it can leave their bodies out, and that is all it needs to know.
    /// The grant is column-level on purpose: the service never sees <c>password_hash</c>, so a
    /// compromise of it yields no verifier to attack offline.
    /// </para>
    /// <para>
    /// <c>item_unlock</c> is Core's alone. The collaboration service asks Core whether a caller
    /// may read an item and never decides it from a grant row itself - one authorization path.
    /// </para>
    /// </remarks>
    private static void SplitGrants(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON item_lock FROM PUBLIC;
            REVOKE ALL ON item_unlock FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON item_lock TO {ApplicationRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON item_unlock TO {ApplicationRole};

            REVOKE ALL ON item_lock FROM {CollaborationRole};
            REVOKE ALL ON item_unlock FROM {CollaborationRole};
            GRANT SELECT (tenant_id, item_id) ON item_lock TO {CollaborationRole};
            """);

    /// <summary>
    /// Bounds the verifier's length.
    /// </summary>
    /// <remarks>
    /// The hasher writes well under a hundred characters. The bound is the backstop against a
    /// defect that stores something else - a password, say - in the column.
    /// </remarks>
    private static void Bound(Action<string> emit) =>
        emit("""
            ALTER TABLE item_lock ADD CONSTRAINT item_lock_password_hash_bounded
                CHECK (char_length(password_hash) BETWEEN 32 AND 256);
            """);

    /// <summary>
    /// Keeps locked bodies out of the derived search index, and re-indexes an item when it is locked
    /// or unlocked.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The index is fed through two readers the worker calls with the service secret and no
    /// principal, so the lock has to be applied inside them: the body reader returns no body for a
    /// locked item, and the metadata reader returns no outgoing links (they were extracted from the
    /// body). Titles and properties are unchanged, as they are everywhere else.
    /// </para>
    /// <para>
    /// Locking or unlocking queues the same <c>item.changed</c> event a body edit does, through the
    /// existing <c>nix_queue_body_search_event</c> - its only inputs are <c>tenant_id</c> and
    /// <c>item_id</c>, which <c>item_lock</c> carries - so the worker drops the text from the index
    /// on lock and restores it on removal. Deferred like the other search triggers, so a rolled-back
    /// lock queues nothing.
    /// </para>
    /// <para>
    /// <c>CREATE OR REPLACE</c> keeps the signatures, owners and grants the original migration set.
    /// </para>
    /// </remarks>
    private static void WithholdFromSearchIndex(Action<string> emit)
    {
        emit("""
            CREATE CONSTRAINT TRIGGER item_lock_search_outbox
                AFTER INSERT OR DELETE ON item_lock
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW
                EXECUTE FUNCTION nix_queue_body_search_event();
            """);
        emit(LockAwareSearchIndexReaders);
    }

    private const string LockAwareSearchIndexReaders = """
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

    /// <summary>The readers exactly as <c>SearchIndexOutboxSecuritySql</c> created them.</summary>
    private const string OriginalSearchIndexReaders = """
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

        CREATE OR REPLACE FUNCTION nix_read_search_index_body(p_tenant_id uuid, p_item_id uuid)
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
        """;
}
