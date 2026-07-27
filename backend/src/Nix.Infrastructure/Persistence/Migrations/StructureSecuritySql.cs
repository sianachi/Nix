namespace Nix.Infrastructure.Persistence.Migrations;

/// <summary>
/// The hand-written half of the MVP-2 migration: bounds on the two new JSON columns, and the
/// index that makes ordering an item's children by name a query rather than a scan.
/// </summary>
/// <remarks>
/// <para>
/// Kept outside <c>Generated/</c> because the scaffolder does not produce it and would overwrite
/// it if it lived there. The generated migration calls <see cref="Apply"/> as its last step, which
/// is the same arrangement the M0 and content migrations use.
/// </para>
/// <para>
/// Nothing here touches row-level security. <c>item</c> already carries the tenant policy and the
/// runtime grants it needs; two more columns on a protected table are protected by construction,
/// which is the property the single-table model was chosen for.
/// </para>
/// </remarks>
public static class StructureSecuritySql
{
    /// <summary>
    /// Emits every statement, in order.
    /// </summary>
    /// <param name="emit">Receives one statement batch at a time.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        BoundStructureColumns(emit);
        IndexTitleForOrdering(emit);
        IndexSchemaDeclarations(emit);
    }

    /// <summary>
    /// Bounds the two new client-influenced JSON columns.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The same 32 KB the property bag already carries, for the same reason: a <c>jsonb</c> column
    /// read into a .NET string is UTF-16, every envelope write copies before and after images into
    /// the audit trail, and a client that could grow these without limit could put Core's resident
    /// memory outside its budget by editing a schema in a loop.
    /// </para>
    /// <para>
    /// The bound is added now, while the columns are empty, because adding one later costs a
    /// full-table validation scan. A schema large enough to hit 32 KB is a modelling mistake -
    /// several hundred declared properties - and failing at the write is better than discovering
    /// it in a listing.
    /// </para>
    /// </remarks>
    private static void BoundStructureColumns(Action<string> emit) =>
        emit("""
            ALTER TABLE item ADD CONSTRAINT item_schema_bounded
                CHECK (schema IS NULL OR octet_length(schema::text) <= 32768);

            ALTER TABLE item ADD CONSTRAINT item_views_bounded
                CHECK (views IS NULL OR octet_length(views::text) <= 32768);
            """);

    /// <summary>
    /// Indexes the title for ordering and for prefix matching within a parent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The debt the property bag has carried since M0.</b> A title lives inside
    /// <c>properties</c> rather than in a column of its own, which is correct - a name is one of
    /// the schema-driven properties an item carries - but it left "order these children by name" as a
    /// query nobody could serve without reading and parsing every row.
    /// </para>
    /// <para>
    /// The expression is <c>properties -&gt;&gt; 'title'</c>, which is immutable and therefore
    /// indexable. Leading with <c>tenant_id</c> and <c>parent_id</c> matches how the list view
    /// actually reads: one parent's children, ordered by one property. A bare index on the
    /// expression alone would still make the planner sort a parent's children after filtering.
    /// </para>
    /// <para>
    /// <c>text_pattern_ops</c> so a prefix search can use the same index: the C collation is what
    /// makes <c>LIKE 'foo%'</c> indexable, and searching a subtree by the start of a name is the
    /// next thing anybody asks for.
    /// </para>
    /// </remarks>
    private static void IndexTitleForOrdering(Action<string> emit) =>
        emit("""
            CREATE INDEX ix_item_title
                ON item (tenant_id, parent_id, (properties ->> 'title') text_pattern_ops)
                WHERE lifecycle_state = 'active';
            """);

    /// <summary>
    /// Indexes the items that declare a schema.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Resolving an effective schema walks an item's ancestors and asks which of them declare one.
    /// Almost none do: a schema sits on a handful of container items in a workspace of thousands.
    /// A partial index over exactly those rows is therefore small enough to stay in memory, and
    /// turns the ancestor walk's second half into an index lookup rather than a heap fetch per
    /// ancestor.
    /// </para>
    /// <para>
    /// Partial rather than complete for the same reason: indexing the millions of rows that carry
    /// no schema would cost writes on every item in the system to speed up a read that only ever
    /// touches the few that do.
    /// </para>
    /// </remarks>
    private static void IndexSchemaDeclarations(Action<string> emit) =>
        emit("""
            CREATE INDEX ix_item_declares_schema
                ON item (tenant_id, id)
                WHERE schema IS NOT NULL;
            """);
}
