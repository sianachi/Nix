namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Finding items by what they are called and by what their documents say.
/// </summary>
/// <remarks>
/// <para>
/// <b>The permission filter is a predicate in the statement, not a pass over the results.</b>
/// Every statement here takes the readable workspaces as a parameter, resolved through
/// <c>IPermissionResolver</c> before the query runs and never sent by the client. Filtering
/// afterwards would be wrong in three separate ways at once: the row count would describe rows the
/// caller may not see, the ranking would be computed against them, and a limit would be spent on
/// them - so a page could come back empty while matches existed. The client never computes
/// permissions and the server never discards rows it should not have read.
/// </para>
/// <para>
/// <b>Two sources, one query.</b> A title lives on <c>item</c>, in <c>properties</c>, and is
/// written by Core. A body's words live in <c>item_search</c> and are written by the collaboration
/// service. They are joined here rather than denormalised into one row, so renaming an item is
/// visible to the next search with no reindex - and a rename is the most common edit an item ever
/// receives.
/// </para>
/// <para>
/// <b>The dictionary is named, not inherited.</b> <c>english</c> is spelled out in every statement
/// because <c>default_text_search_config</c> is a per-database, per-session setting: a vector built
/// under one configuration and queried under another silently stops matching. The migration that
/// built the column names the same one, and a disagreement is then two visible lines of SQL rather
/// than an invisible dependency on server configuration.
/// </para>
/// <para>
/// The measured runtime-role plan at the phase corpus uses
/// <c>IX_item_tenant_id_workspace_id</c> to bound the title arm and a bounded
/// <c>item_search</c> scan for the body arm. The expression indexes remain available to a future
/// planner, but are not claimed as runtime dependencies. Derived visibility additionally depends
/// on the closure descendant index and the item point key; <c>BulkItemVisibilityPlanEvidenceTests</c>
/// records the exact RLS plan.
/// </para>
/// </remarks>
public static class SearchSql
{
    /// <summary>
    /// Items whose title or document text matches, most relevant first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A title match outranks a body match, always.</b> Somebody typing into a palette is
    /// usually trying to reach a document they can already name, and a note that merely mentions
    /// the word must not come above the note called it. That is a sort key rather than a filter,
    /// so a body-only match is still returned - just below.
    /// </para>
    /// <para>
    /// <b>Two arms unioned, rather than one scan with an <c>OR</c>.</b> The obvious shape - join
    /// <c>item_search</c> and write <c>title ILIKE ... OR body_vector @@ ...</c> - cannot use
    /// one combined index. No single index spans two tables, and one joined arm would make the
    /// permission and match predicates inseparable. Split, each source keeps its own permission
    /// predicate and physical plan, and the aggregate merges the two. The runtime-role evidence at
    /// the current corpus uses the workspace index for titles and scans the bounded search table
    /// for bodies; it does not pretend the two expression indexes were selected when they were not.
    /// </para>
    /// <para>
    /// <b>The permission predicate appears in both arms, and must.</b> It is stated twice because
    /// there are two ways in, and an arm without it is a way in without a check. They are in one
    /// statement so both are read together; a reviewer who sees one and not the other is looking at
    /// a bug.
    /// </para>
    /// <para>
    /// The title arm alone reaches items with no document body at all, which is most of a freshly
    /// imported workspace. Its rank is a constant rather than a computed one - a title match is
    /// ordered ahead of every body match by <c>title_matched</c> before rank is consulted at all,
    /// so computing a text rank for it would be arithmetic nothing reads.
    /// </para>
    /// <para>
    /// <c>bool_or</c> and <c>max</c> over the union: an item matching both ways appears in both arms
    /// and must come back once, as a title match, carrying the body rank it earned.
    /// </para>
    /// <para>
    /// <c>websearch_to_tsquery</c> rather than <c>plainto_tsquery</c>: it takes quoted phrases and
    /// <c>or</c> and <c>-</c> from anybody who has used a search engine, and - unlike
    /// <c>to_tsquery</c> - it cannot be made to raise a syntax error by typing a bare bracket,
    /// which is the sort of thing a person types into a search box constantly.
    /// </para>
    /// <para>
    /// The tie-break on <c>item.id</c> is not decoration. Two equally ranked rows in an unstable
    /// order make the same query return a different page each time it runs, which reads as results
    /// flickering as somebody types.
    /// </para>
    /// </remarks>
    public const string MatchingItems = """
        WITH matches AS (
            SELECT item.id AS item_id,
                   true AS title_matched,
                   0::real AS rank
            FROM item
            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND (item.properties ->> 'title') ILIKE @title_pattern ESCAPE '\'

            UNION ALL

            SELECT search.item_id,
                   false AS title_matched,
                   ts_rank(search.body_vector, websearch_to_tsquery('english', @query)) AS rank
            FROM item_search AS search
            JOIN item
              ON item.tenant_id = search.tenant_id
             AND item.id = search.item_id
            WHERE search.tenant_id = @tenant_id
              AND search.body_vector @@ websearch_to_tsquery('english', @query)
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
        ),
        ranked AS (
            SELECT item_id,
                   bool_or(title_matched) AS title_matched,
                   max(rank) AS rank
            FROM matches
            GROUP BY item_id
        )
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title
        FROM ranked
        JOIN item
          ON item.tenant_id = @tenant_id
         AND item.id = ranked.item_id
         AND item.template_id IS NULL
         AND item.lifecycle_state = 'active'
         AND NOT EXISTS (
             SELECT 1
             FROM item_closure AS visibility_edge
             LEFT JOIN LATERAL (
                 SELECT visibility_ancestor.template_id,
                        visibility_ancestor.lifecycle_state
                 FROM item AS visibility_ancestor
                 WHERE visibility_ancestor.tenant_id = @tenant_id
                   AND visibility_ancestor.id = visibility_edge.ancestor_id
                 LIMIT 1
             ) AS stored_ancestor ON TRUE
             WHERE visibility_edge.tenant_id = @tenant_id
               AND visibility_edge.descendant_id = item.id
               AND visibility_edge.depth > 0
               AND (stored_ancestor.template_id IS NOT NULL
                    OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
             OFFSET 0
         )
        ORDER BY ranked.title_matched DESC, ranked.rank DESC, item.id
        LIMIT @limit
        """;

    /// <summary>
    /// The items among a given set that the caller may read, with their titles.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a document's references resolve against. An identifier absent from the result is one of
    /// three things - it never existed, it was deleted, or it belongs to a workspace this caller
    /// cannot reach - and the caller is told none of them, because telling them apart is how an
    /// outsider enumerates a tenant one identifier at a time. The reader gets a stub either way.
    /// </para>
    /// <para>
    /// <b>This is the statement that stops a title leaking.</b> A reference node carries a cached
    /// <c>label</c> - the target's title as of when the link was made - and that cache is a title
    /// the reader may have no entitlement to. Resolution has to be the thing that decides whether
    /// they see one, so this returns a title only for a row that passed the workspace predicate,
    /// and returns no row at all otherwise.
    /// </para>
    /// <para>
    /// Index dependencies: <c>PK_item</c> for the identifier lookup, then the workspace and
    /// lifecycle columns as filters on the fetched rows.
    /// </para>
    /// </remarks>
    public const string ReadableItemsById = """
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title
        FROM item
        WHERE item.tenant_id = @tenant_id
          AND item.id = ANY(@item_ids)
          AND item.workspace_id = ANY(@workspace_ids)
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = item.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        """;

    /// <summary>
    /// The items whose documents refer to a given item, most-referring first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The backlinks read. It starts from <c>item_link</c> on the target and joins back to
    /// <c>item</c> for the source's name, so the workspace predicate applies to the <i>source</i> -
    /// which is the one being disclosed. A reader entitled to the item they are looking at is not
    /// thereby entitled to know that a document in a workspace they cannot reach mentions it, and
    /// the count in the panel must not include it either.
    /// </para>
    /// <para>
    /// Ordered by <c>occurrences</c> so a document that discusses the target at length comes above
    /// one that mentions it once in passing, then by title so the order is stable, then by
    /// identifier because two items may share a title.
    /// </para>
    /// <para>
    /// Index dependencies: <c>ix_item_link_target</c> for the driving lookup, then
    /// <c>item_pkey</c> for each source.
    /// </para>
    /// </remarks>
    public const string ItemsLinkingTo = """
        SELECT source.id,
               source.workspace_id,
               source.type,
               source.properties ->> 'title' AS title,
               link.occurrences
        FROM item_link AS link
        JOIN item AS source
          ON source.tenant_id = link.tenant_id
         AND source.id = link.source_item_id
        WHERE link.tenant_id = @tenant_id
          AND link.target_item_id = @target_item_id
          AND source.workspace_id = ANY(@workspace_ids)
          AND source.lifecycle_state = 'active'
          AND source.template_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = source.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        ORDER BY link.occurrences DESC, title, source.id
        LIMIT @limit
        """;
}
