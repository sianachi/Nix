namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written half of the TaskSemantics migration: the recurrence bound and the three
/// partial indexes. Outside <c>Generated/</c> so a re-scaffold cannot erase it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why <c>due_day</c> is indexed and the property bag is not.</b> Under row security, a
/// predicate over <c>properties -&gt;&gt; key</c> can never become an index condition:
/// <c>jsonb_object_field_text</c> and <c>left()</c> are not leakproof, so Postgres refuses to
/// evaluate them below the row-security qual, and the clause is demoted to a heap filter after
/// every row is fetched. Measured on a 100k corpus as the runtime role: the same query against the
/// same expression index ran 0.507 ms with RLS bypassed and 58.484 ms with it enforced (18,827
/// buffers, 18,474 rows discarded). A stored generated column is a plain column reference, which
/// is leakproof - so <c>ix_item_due_day</c> serves Overdue at 4.9 ms / 1,026 buffers where the
/// seq-scan baseline was 99.7 ms / 5,527, with the sort node gone entirely.
/// </para>
/// <para>
/// <b>Which numbers CI holds and which it does not:</b> every figure in this file comes from the
/// one-off design measurement (2026-08-21, a 100k-row clone with the real policy and roles). The
/// standing check is <c>TaskSemanticsPlanEvidenceTests</c>, which asserts the planner's *choices*
/// - the named index scans, no seq scan, no sort - as the runtime role against a 55k two-tenant
/// corpus; it does not re-measure the millisecond figures. <c>ix_item_recurs</c> ships one goal
/// ahead of its consumer: it was measured against a prototype of 3.2's candidate query, and 3.2
/// owes the plan-evidence assertion for it when the real statement lands.
/// </para>
/// <para>
/// <b>The seeded template presets are deliberately untouched.</b> They carry the convention keys
/// (<c>done</c>, <c>owner</c>, <c>starts</c>) that goal 3.4 owns the rebinding of; rewriting them
/// here would be a data migration of user-visible content smuggled into a schema migration, and
/// would do half of 3.4 while leaving the other half owed. None of them collides with the five
/// reserved task keys.
/// </para>
/// <para>
/// <b><c>item_recurrence_bounded</c> is TODAY the only guard, and that is a named debt.</b> The
/// storage ships one goal ahead of its engine (ADR-0002's shape): goal 3.2 owes a
/// <c>RecurrenceRuleJson.MaximumBytes</c> check at its one write path, returning a mapped refusal
/// with a stable code. Until 3.2 lands, nothing writes this column - and if anything did, a
/// breach would surface as a constraint violation and a 500, not a problem detail. The 3.2
/// implementer must not read this CHECK as the handled path.
/// </para>
/// <para>
/// <b>Apply-time cost:</b> the generated <c>due_day</c> column in this migration's EF half is
/// <c>ADD COLUMN ... GENERATED ... STORED</c>, which takes ACCESS EXCLUSIVE and rewrites the
/// whole <c>item</c> table - measured ~2.6 s per 100k rows. Plan the outage by row count.
/// </para>
/// <para>
/// No new row-security policy is owed and none may be omitted: both new columns land on
/// <c>item</c>, which already carries <c>item_tenant_isolation</c> with forced row security, and
/// columns on a protected table are protected by construction. This migration introduces no new
/// table.
/// </para>
/// </remarks>
public static class TaskSemanticsSecuritySql
{
    /// <summary>Applies the hand-written DDL, in dependency order.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        // A rule is not a document: the fixed part is ~120 bytes and the exception list is bounded
        // at 200 entries (~2,750 bytes) by the handler, so 4 KB leaves headroom without inviting
        // documents in. The bound goes on while the column is empty; adding one later costs a full
        // validation scan.
        emit(
            """
            ALTER TABLE item ADD CONSTRAINT item_recurrence_bounded
                CHECK (recurrence IS NULL OR octet_length(recurrence::text) <= 4096);
            """);

        // Serves the Overdue / Today / Next-N smart-list shape: range or equality on the day, in
        // tenant, active, non-template - all in the index condition, with the ordering the
        // starters want falling out of the key order (no sort node). Default opclass on purpose:
        // fixed-width yyyy-MM-dd text orders identically under any collation, and text_pattern_ops
        // would refuse the range operators under the database's libc collation.
        emit(
            """
            CREATE INDEX ix_item_due_day
                ON item (tenant_id, due_day, id)
                WHERE lifecycle_state = 'active'
                  AND template_id IS NULL
                  AND due_day IS NOT NULL;
            """);

        // The recurrence-candidate walk: every recurring item in a workspace, joined to its
        // container. Leading (tenant_id, workspace_id) because the read is workspace-scoped - one
        // range scan per workspace beats a probe per container - and parent_id third so the
        // container join stays inside the index. Measured 2.704 ms / 407 buffers on a 50k
        // workspace against 44.807 ms / 24,760 without it.
        emit(
            """
            CREATE INDEX ix_item_recurs
                ON item (tenant_id, workspace_id, parent_id)
                WHERE recurrence IS NOT NULL
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);

        // The calendar's container arm reads `views`, which was unindexed: on a 10k workspace the
        // bitmap scan read all 10,001 rows to find 30. Same shape and rationale as
        // ix_item_declares_schema - almost no rows qualify, so the index is tiny and resident.
        // Measured: the container CTE fell from 4.432 ms / 473 buffers to 0.708 ms / 4.
        emit(
            """
            CREATE INDEX ix_item_declares_views
                ON item (tenant_id, workspace_id)
                WHERE views IS NOT NULL
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);
    }

    /// <summary>Reverts the hand-written DDL, before the generated Down drops the columns.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("DROP INDEX IF EXISTS ix_item_declares_views;");
        emit("DROP INDEX IF EXISTS ix_item_recurs;");
        emit("DROP INDEX IF EXISTS ix_item_due_day;");
        emit("ALTER TABLE item DROP CONSTRAINT IF EXISTS item_recurrence_bounded;");
    }
}
