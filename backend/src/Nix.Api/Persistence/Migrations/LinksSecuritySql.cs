namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written half of the links and search migration: isolation policies and the grant split
/// for the two derived tables, the search vector column and its index, and the trigram index that
/// makes finding an item by part of its title a lookup rather than a scan.
/// </summary>
/// <remarks>
/// <para>
/// Outside <c>Migrations/Generated</c> because that folder is rewritten wholesale by the next
/// scaffold, and this SQL is the only thing that isolates these tables. Frozen to its migration: a
/// later phase writes its own equivalent rather than editing this, because a migration is a record
/// of what was applied on a particular day.
/// </para>
/// <para>
/// Two things here are not expressible in the EF model at all and are the reason this file is
/// larger than <see cref="StructureSecuritySql"/>: a <c>tsvector</c> column, whose type no domain
/// entity can name without a dependency on Npgsql, and two operator-class indexes, which are a
/// property of how Postgres searches rather than of the schema.
/// </para>
/// </remarks>
public static class LinksSecuritySql
{
    /// <summary>The runtime role the API connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    /// <summary>Tables this migration creates, both tenant-scoped and both derived.</summary>
    private static readonly string[] DerivedTables =
    [
        "item_link",
        "item_search",
    ];

    /// <summary>
    /// Emits every statement, in dependency order.
    /// </summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        AssertRolesExist(emit);
        ProtectDerivedTables(emit);
        SplitGrants(emit);
        AllowCollaborationToReferenceItems(emit);
        AddSearchVector(emit);
        IndexTitlesForSubstringSearch(emit);
    }

    /// <summary>
    /// Refuses to continue if either role is missing.
    /// </summary>
    /// <remarks>
    /// Both are granted to below. Applying this migration without them would leave two tables
    /// carrying whatever the schema default happens to be, which - because the seed's default
    /// privileges grant the application full DML on anything the migrator creates - means writable
    /// by the service that must never write them.
    /// </remarks>
    private static void AssertRolesExist(Action<string> emit) =>
        emit($"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{ApplicationRole}') THEN
                    RAISE EXCEPTION 'the runtime role {ApplicationRole} does not exist; refusing to apply the links schema';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{CollaborationRole}') THEN
                    RAISE EXCEPTION 'the collaboration role {CollaborationRole} does not exist; run deploy/seed/seed.sh before migrating';
                END IF;
            END
            $$;
            """);

    /// <summary>
    /// Puts the tenant isolation policy on each derived table.
    /// </summary>
    /// <remarks>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present so a read filter cannot be mistaken for a write guard; <c>current_setting(..., true)</c>
    /// so an unscoped session sees nothing rather than raising; <c>FORCE</c> so the owner is subject
    /// to it too.
    ///
    /// Derived data is not less sensitive than the data it derives from. An edge says one document
    /// mentions another and a search vector is the document's own words; a reader who may not open
    /// either must not be able to read either, whichever service has the bug.
    /// </remarks>
    private static void ProtectDerivedTables(Action<string> emit)
    {
        foreach (var table in DerivedTables)
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
                """);
        }
    }

    /// <summary>
    /// Read-only for the application, read-write for the collaboration service.
    /// </summary>
    /// <remarks>
    /// The content tables' split, carried one step further. Both of these are extracted from a
    /// materialised document, and materialising a document means applying its update log, which
    /// needs a CRDT runtime Core does not have and should not grow. Core reads what was derived and
    /// never derives it, so a bug in Core cannot silently rewrite the link graph.
    ///
    /// The seed's <c>ALTER DEFAULT PRIVILEGES</c> grants the application full DML on anything the
    /// migrator creates, so the <c>REVOKE</c> is the load-bearing statement here, not the
    /// <c>GRANT</c>.
    /// </remarks>
    private static void SplitGrants(Action<string> emit)
    {
        foreach (var table in DerivedTables)
        {
            emit($"""
                REVOKE ALL ON {table} FROM {ApplicationRole};
                GRANT SELECT ON {table} TO {ApplicationRole};

                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {CollaborationRole};
                """);
        }
    }

    /// <summary>
    /// Lets the collaboration role satisfy the foreign keys into <c>item</c>, and test whether a
    /// link target exists before writing an edge to it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Both tables reference <c>item(tenant_id, id)</c>, and Postgres requires the
    /// <c>REFERENCES</c> privilege on the referenced columns from whoever inserts the referencing
    /// row.
    /// </para>
    /// <para>
    /// <b>The <c>SELECT</c> is column-level, and deliberately.</b> A reference's target comes out
    /// of a document, which means it comes from a browser: it can name an item that was deleted or
    /// that never existed. Without a way to test for the target first, one stale reference would
    /// fail the foreign key, abort the transaction, and take the snapshot with it - a document
    /// that stops saving because of a link. The service therefore needs to ask whether an id
    /// exists, and nothing more. Granted on <c>(tenant_id, id)</c> alone, it can ask exactly that:
    /// a title, a body, a parent and a workspace all stay unreadable, and the row-level policy
    /// still confines the answer to the tenant the session is scoped to.
    /// </para>
    /// </remarks>
    private static void AllowCollaborationToReferenceItems(Action<string> emit) =>
        emit($"""
            GRANT REFERENCES (tenant_id, id) ON item TO {CollaborationRole};
            GRANT SELECT (tenant_id, id) ON item TO {CollaborationRole};
            """);

    /// <summary>
    /// Adds the search vector and the index that searches it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Not a generated column over <c>content_snapshot.plaintext</c>, which is where it looks like
    /// it belongs. <c>content_snapshot</c> holds many rows per document - one every few hundred
    /// updates, one every few minutes, one on eviction - so a vector there would index text the
    /// document no longer contains and return documents that no longer match. "The newest snapshot"
    /// is not a property of a row, so no partial index could exclude the history either. One row
    /// per item, replaced on each extraction, is both correct and an order of magnitude smaller.
    /// </para>
    /// <para>
    /// <c>NOT NULL</c> is affordable because the table is created empty in this same migration and
    /// its only writer always materialises the whole document before writing. A document with no
    /// words yields an empty vector, which matches nothing - that is a different fact from an
    /// absent one, and the distinction is worth keeping out of the query.
    /// </para>
    /// <para>
    /// GIN rather than GiST: this index is read far more often than it is written, entries are
    /// rewritten wholesale rather than incrementally, and GIN's lookup is the faster of the two by
    /// a wide margin for exactly that shape.
    /// </para>
    /// <para>
    /// The dictionary is pinned to <c>english</c> in the column, not left to
    /// <c>default_text_search_config</c>, because that setting is per-database and per-session: a
    /// vector built under one configuration and queried under another silently stops matching.
    /// Making the choice explicit here means the query must state the same one, and a mismatch is a
    /// visible disagreement between two lines of SQL rather than an invisible one with the server's
    /// configuration.
    /// </para>
    /// </remarks>
    private static void AddSearchVector(Action<string> emit) =>
        emit("""
            ALTER TABLE item_search
                ADD COLUMN body_vector tsvector NOT NULL DEFAULT to_tsvector('english', '');

            CREATE INDEX ix_item_search_body_vector ON item_search USING GIN (body_vector);
            """);

    /// <summary>
    /// Indexes titles for substring search across a whole tenant.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>ix_item_title</c> already exists and cannot serve this. It leads with
    /// <c>(tenant_id, parent_id)</c>, which is right for ordering one container's children and
    /// useless for "find an item called something like this, anywhere" - the query a reference
    /// picker and a command palette both are. Its <c>text_pattern_ops</c> also only reaches
    /// prefixes, and nobody typing into a palette starts at the beginning of the title.
    /// </para>
    /// <para>
    /// Trigrams answer both: <c>ILIKE '%needle%'</c> becomes an index lookup, and the same index
    /// serves similarity ranking if this is ever ordered by closeness rather than by whether the
    /// title matched at all.
    /// </para>
    /// <para>
    /// Partial on <c>lifecycle_state = 'active'</c>, matching the index it sits beside. A deleted
    /// item is not a search result, so indexing one costs writes to return rows the query then has
    /// to discard.
    /// </para>
    /// </remarks>
    private static void IndexTitlesForSubstringSearch(Action<string> emit) =>
        emit("""
            CREATE EXTENSION IF NOT EXISTS pg_trgm;

            CREATE INDEX ix_item_title_trgm
                ON item USING GIN ((properties ->> 'title') gin_trgm_ops)
                WHERE lifecycle_state = 'active';
            """);
}
