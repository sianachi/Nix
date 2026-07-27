namespace Nix.Infrastructure.Persistence.Sql.Statements;

/// <summary>
/// The ancestor walk that resolves an effective property schema.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than LINQ, per the data-access rule: this runs on every write that carries
/// properties and on every listing that renders them, and its plan has to stay legible.
/// </para>
/// <para>
/// Tenant-parameterised as well as relying on the isolation policies - defence in depth, and a
/// predicate the planner can turn into an index condition.
/// </para>
/// </remarks>
public static class SchemaSql
{
    /// <summary>
    /// Every schema declared on an item's ancestor chain, nearest first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Ordered by depth ascending, which is nearest first</b>, because that is the order the
    /// merge and the <c>inherit</c> stop both need: the caller walks outwards and stops at the
    /// first declaration that refuses to inherit, without having to know how long the chain is.
    /// </para>
    /// <para>
    /// The self-edge at depth zero is included deliberately - an item's own declaration is part of
    /// its effective schema, and excluding it would make "the schema at this item" and "the schema
    /// its children see" the same query, which they are not.
    /// </para>
    /// <para>
    /// Only rows that declare something are returned. The partial index
    /// <c>ix_item_declares_schema</c> exists for exactly this predicate, so a chain of twenty
    /// ancestors where two carry a schema fetches two rows rather than twenty.
    /// </para>
    /// <para>
    /// Index dependencies: <c>PK_item_closure</c> for the ancestor lookup and
    /// <c>ix_item_declares_schema</c> for the join.
    /// </para>
    /// </remarks>
    public const string AncestorSchemas = """
        SELECT ancestor.schema, edge.depth
        FROM item_closure AS edge
        JOIN item AS ancestor
          ON ancestor.id = edge.ancestor_id
         AND ancestor.tenant_id = edge.tenant_id
        WHERE edge.tenant_id = @tenant_id
          AND edge.descendant_id = @item_id
          AND ancestor.schema IS NOT NULL
        ORDER BY edge.depth
        """;
}
