namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Aggregates over an item's children: what a rollup property reduces to, and what a chart groups.
/// </summary>
/// <remarks>
/// <para>
/// <b>Hand-written because a rollup is an aggregate, and an aggregate belongs where the rows
/// are.</b> The alternative is the client fetching every child of every item it draws a rollup for,
/// which the stress row (2.5) puts at 3,000+ children per container and which is not expressible at
/// all for a list of a hundred items each showing one. ADR-0044 records the split.
/// </para>
/// <para>
/// <b>One statement for a whole page, and for every rollup on it.</b> The parents come in as an
/// array and the property keys come in as a second array, so a page of fifty items declaring three
/// rollups is one query, not a hundred and fifty. Each parent's children are read once and fanned
/// out per key inside, rather than once per key.
/// </para>
/// <para>
/// <b>The lateral is the shape, and it is there because the measurement said so.</b> Written as a
/// plain join from <c>unnest(@parent_ids)</c> to <c>item</c>, the planner hashed the fifty parents
/// and read the whole workspace: over a 120,000-child corpus it chose a parallel sequential scan
/// and touched every row to answer a question about a tenth of them. That plan is not wrong at that
/// size - it is wrong at the next size, because its cost grows with the workspace rather than with
/// the page. A lateral subquery carrying an aggregate cannot be hoisted into a hash join, so the
/// parents drive: one index range per parent, and the cost of drawing a page depends on what is
/// under the page. <c>RollupPlanEvidenceTests</c> holds both halves of that.
/// </para>
/// <para>
/// <b>Every reduction is computed in the same pass, and the caller picks the one its property
/// declared.</b> The alternative - a statement per aggregate, or SQL assembled from the aggregate
/// name - would either multiply the scans or interpolate a value into statement text, and the
/// second is the thing this codebase does not do. The extra aggregates are folds over rows already
/// being scanned; they cost arithmetic, not I/O.
/// </para>
/// <para>
/// <b>Types are checked in jsonb rather than cast hopefully.</b> A property value is
/// client-influenced data, and <c>(properties->>'estimate')::numeric</c> over a bag where one row
/// holds the text "soon" fails the whole statement - one bad value would cost every rollup on the
/// page. <c>jsonb_typeof</c> guards each cast, so a value of the wrong shape is not counted rather
/// than fatal, which is the same posture <c>ItemMapping.ReadProperties</c> takes for the same
/// reason. Absence is told from an explicit null the same way: <c>jsonb_typeof</c> answers SQL null
/// for a key the bag does not carry and the text <c>null</c> for one it carries as null, and
/// neither counts as a value.
/// </para>
/// <para>
/// <b>Magnitude is bounded as well as kind, and that is a crash rather than a tidiness rule.</b>
/// Postgres <c>numeric</c> is arbitrary precision and <see cref="decimal"/> is not, so a value the
/// property validator accepts - it admits anything that reads as a <c>double</c>, which includes
/// <c>1e308</c> - would reach the reader as a number that does not fit and throw. Measured in the
/// review of goal 2.2 against the pinned driver: one child holding <c>1e308</c>, or twenty each
/// holding a perfectly ordinary <c>1e28</c>, both raise <c>OverflowException</c> - and the blast
/// radius is not the rollup but the whole of <c>GET /workspaces/{id}/items</c>, as an opaque 500.
/// One person typing one number would break the listing of a container for everyone.
/// <para>
/// So each value is counted only when it is within 1e15, and the sum only when the total is within
/// 1e28. A value outside the bound is not counted rather than fatal, exactly as a value of the
/// wrong kind is not - the same posture, extended from kind to size. A sum that overflows answers
/// null, which <see cref="Nix.Domain.Properties.ChildAggregate"/> publishes as "no answer" rather
/// than as a zero somebody would act on. The remaining half of the fix belongs in
/// <c>PropertyValidator</c>, where an unrepresentable number should not be storable at all; that
/// is a change to what every Number property accepts and is recorded as owed rather than smuggled
/// in here.
/// </para>
/// </para>
/// <para>
/// <b>The <c>?</c> containment operator is deliberately not used</b>, though it would read more
/// directly. It is the one jsonb operator whose spelling collides with a parameter placeholder in
/// several drivers, and a statement that works until somebody changes how parameters are bound is
/// a statement waiting to break for a reason nobody would look for here.
/// </para>
/// <para>
/// <b>Tenant-parameterised as well as row-level-security-scoped</b>, defence in depth as the
/// security model requires and what lets the planner use an index condition rather than evaluating
/// the policy per row. Deleted and template rows are excluded here rather than filtered afterwards:
/// a rollup that counted a deleted child would disagree with the list drawn beside it.
/// </para>
/// <para>
/// <b>Derived visibility is checked on the parent, not on each child, and the two are the same
/// question.</b> A child's proper ancestors are its parent plus its parent's - so asking whether
/// the parent's own path is entirely active answers it for every child of that parent at once, in
/// fifty probes rather than fifteen thousand. That is why the probe reads
/// <c>visibility_edge.depth &gt;= 0</c> where every other bulk read reads <c>&gt; 0</c>: the anchor
/// here is the parent, whose own lifecycle is one of the facts a child's visibility depends on.
/// </para>
/// <para>
/// <b>Without it, a deleted container discloses its children by aggregate.</b>
/// <c>GET /workspaces/{id}/items?includeDeleted=true</c> is an ordinary read and its page can carry
/// a deleted item; the fold would then answer count, sum, minimum, maximum and average over that
/// item's still-active children - rows every other endpoint refuses, since a point read of one is
/// a 404 and listing them is a refused parent. A minimum and a maximum are not counts: they are
/// exact stored values of particular hidden rows. Found in the security review of goal 2.2; the
/// six bulk reads that <c>03db4db</c> corrected carry the same predicate for the same reason, and
/// <c>BulkItemVisibilityStatementTests</c> is where a seventh that forgets it is caught.
/// </para>
/// <para>
/// <b>Index dependency, as measured rather than as hoped: <c>IX_item_tenant_id_parent_id</c></b>,
/// one index range per parent. Not <c>IX_item_workspace_id_parent_id_seq</c>, which this comment
/// named first and which the planner does not choose - the lateral's condition is on the tenant and
/// the parent, and the workspace is a filter on top. <c>RollupPlanEvidenceTests</c> captures and
/// explains the production command under the runtime role and RLS.
/// </para>
/// <para>
/// <b>What the lateral costs, and why it is still right.</b> Measured over the 120,000-child corpus,
/// folding 50 containers of 300 children each - a page wanting an eighth of the workspace, which is
/// dense for a real one: the sequential plan ran in 23.5 ms over 4,054 buffers and the lateral in
/// 39.7 ms over 15,100. The lateral is the slower of the two <em>at that size</em>, because an index
/// path pays about a buffer per row where a sequential scan gets thirty rows to a page. It is the
/// right one anyway: its cost is a function of what is under the page, and the other's is a function
/// of how big the workspace has become. The first is a number that stays where it is; the second is
/// the one that ends a phase.
/// </para>
/// <para>
/// <b>The per-key fan-out is a tuplestore, not an extra read, and its cost is temp I/O rather than
/// buffers.</b> Postgres puts <c>unnest(@keys)</c> on the outer side of the inner nested loop and
/// stacks a <c>Materialize</c> over the index scan, so the children are read once per parent and
/// replayed from a tuplestore once per key. Measured in the review of goal 2.2: 50 parents x 300
/// children x 2 keys costs 15,100 buffers whether there are one or two keys - the second key is
/// free in I/O. What it is not free in is memory: the tuplestore holds whole child tuples, so a
/// container of 3,000 children whose property bags sit just under the TOAST threshold (~1.4 KB,
/// which is an ordinary item with a few text properties) spilled 4.4 MB of temp per parent at
/// three keys, where the same corpus at one key built no tuplestore at all. A bag large enough to
/// TOAST does not spill, because the tuplestore then holds a pointer - so the hazard is the middle
/// size, not the large one.
/// </para>
/// <para>
/// <b>Which is a real trade and is taken deliberately.</b> The alternative measured to help is one
/// execution per key - one to three statements per page instead of one, each with every parent, no
/// <c>Materialize</c> and no temp. That is the shape to move to if a schema's rollup count grows;
/// it is not taken now because it multiplies the round trips for the one-to-three-key case that
/// every real schema has, and because the spill needs a container of thousands to appear at all.
/// The number to beat if it is revisited: zero temp blocks for 3,000 children x 3 keys, against
/// 548 written and 1,096 read today.
/// </para>
/// </remarks>
public static class RollupSql
{
    /// <summary>
    /// Every reduction of every named property, over the children of each of the given parents.
    /// </summary>
    /// <remarks>
    /// Columns, in order: the parent, the property key, how many children the parent has, how many
    /// of them carry a value for that key, and then the numeric fold (count of numbers, sum, min,
    /// max) and the boolean fold (count of booleans, count of true ones). A parent with no children
    /// produces no row at all, so the answer is the size of what was found rather than the size of
    /// what was asked.
    /// </remarks>
    public const string AggregateChildProperties = """
        SELECT p.id AS parent_id,
               fold.key,
               fold.children,
               fold.present,
               fold.numbers,
               fold.total,
               fold.smallest,
               fold.largest,
               fold.booleans,
               fold.truths
        FROM unnest(@parent_ids) AS p(id)
        CROSS JOIN LATERAL (
            SELECT k.key,
                   count(*) AS children,
                   count(*) FILTER (
                       WHERE jsonb_typeof(c.properties -> k.key) IS NOT NULL
                         AND jsonb_typeof(c.properties -> k.key) <> 'null'
                   ) AS present,
                   count(*) FILTER (
                       WHERE jsonb_typeof(c.properties -> k.key) = 'number'
                         AND abs((c.properties ->> k.key)::numeric) <= 1e15
                   ) AS numbers,
                   CASE WHEN abs(sum(CASE WHEN jsonb_typeof(c.properties -> k.key) = 'number'
                                           AND abs((c.properties ->> k.key)::numeric) <= 1e15
                                          THEN (c.properties ->> k.key)::numeric END)) <= 1e28
                        THEN sum(CASE WHEN jsonb_typeof(c.properties -> k.key) = 'number'
                                       AND abs((c.properties ->> k.key)::numeric) <= 1e15
                                      THEN (c.properties ->> k.key)::numeric END) END AS total,
                   min(CASE WHEN jsonb_typeof(c.properties -> k.key) = 'number'
                             AND abs((c.properties ->> k.key)::numeric) <= 1e15
                            THEN (c.properties ->> k.key)::numeric END) AS smallest,
                   max(CASE WHEN jsonb_typeof(c.properties -> k.key) = 'number'
                             AND abs((c.properties ->> k.key)::numeric) <= 1e15
                            THEN (c.properties ->> k.key)::numeric END) AS largest,
                   count(*) FILTER (WHERE jsonb_typeof(c.properties -> k.key) = 'boolean') AS booleans,
                   count(*) FILTER (WHERE c.properties -> k.key = 'true'::jsonb) AS truths
            FROM item AS c
            CROSS JOIN unnest(@keys) AS k(key)
            WHERE c.tenant_id = @tenant_id
              AND c.workspace_id = @workspace_id
              AND c.parent_id = p.id
              AND c.lifecycle_state = 'active'
              AND c.template_id IS NULL
            GROUP BY k.key
        ) AS fold
        WHERE NOT EXISTS (
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
              AND visibility_edge.descendant_id = p.id
              AND visibility_edge.depth >= 0
              AND (stored_ancestor.template_id IS NOT NULL
                   OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
            OFFSET 0
        )
        """;

    /// <summary>
    /// The children of one item, bucketed by one property's value, counted and summed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a chart draws (goal 2.3). Server-side for the reason the rollup above is: a chart over
    /// a container whose children the client has only partly loaded would be a picture of the first
    /// page presented as a picture of the whole, which is exactly the dishonest state the UI rules
    /// forbid.
    /// </para>
    /// <para>
    /// The bucket key is the grouping property's value as text, with children that have none
    /// collected under a null key rather than dropped - "unset" is a real and often large bucket,
    /// and a chart that hid it would misreport every proportion on it.
    /// </para>
    /// <para>
    /// <b>Ordered and bounded here rather than by the caller.</b> A grouping property whose values
    /// are not a declared list can produce a bucket per child; the limit is what stops a chart
    /// request over a free-text column from returning a row per item. The caller is told the total
    /// number of distinct buckets separately so it can say the chart was truncated instead of
    /// quietly drawing the top few as if they were all of them.
    /// </para>
    /// </remarks>
    public const string BucketChildrenByProperty = """
        SELECT c.properties ->> @group_key AS bucket,
               count(*) AS children,
               CASE WHEN abs(sum(CASE WHEN jsonb_typeof(c.properties -> @measure_key) = 'number'
                                       AND abs((c.properties ->> @measure_key)::numeric) <= 1e15
                                      THEN (c.properties ->> @measure_key)::numeric END)) <= 1e28
                    THEN sum(CASE WHEN jsonb_typeof(c.properties -> @measure_key) = 'number'
                                   AND abs((c.properties ->> @measure_key)::numeric) <= 1e15
                                  THEN (c.properties ->> @measure_key)::numeric END) END AS total,
               count(*) OVER () AS buckets,
               sum(count(*)) OVER () AS all_children
        FROM item AS c
        WHERE c.tenant_id = @tenant_id
          AND c.workspace_id = @workspace_id
          AND c.parent_id = @parent_id
          AND c.lifecycle_state = 'active'
          AND c.template_id IS NULL
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
                AND visibility_edge.descendant_id = @parent_id
                AND visibility_edge.depth >= 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        GROUP BY c.properties ->> @group_key
        ORDER BY count(*) DESC, bucket ASC NULLS LAST
        LIMIT @limit
        """;
}
