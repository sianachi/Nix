namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written half of the canvas library migration: the isolation policy on
/// <c>canvas_library</c> and the bound on how large one principal's library may grow.
/// </summary>
/// <remarks>
/// Outside <c>Migrations/Generated</c> because that folder is rewritten wholesale by the next
/// scaffold, and this SQL is the only thing that isolates the table. Frozen to its migration: a
/// later phase writes its own equivalent rather than editing this, because a migration is a record
/// of what was applied on a particular day.
/// </remarks>
public static class CanvasLibrarySecuritySql
{
    /// <summary>
    /// Emits every statement, in dependency order.
    /// </summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        ProtectCanvasLibrary(emit);
        BoundLibrarySize(emit);
    }

    /// <summary>
    /// Puts the tenant isolation policy on <c>canvas_library</c>.
    /// </summary>
    /// <remarks>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the table owner is subject to it too. Tenant isolation is the
    /// boundary this policy draws; a principal reading only their own row is an application-layer
    /// concern, the same way <c>GET /api/v1/me</c> is - the query itself never accepts another
    /// principal's id as input.
    /// </remarks>
    private static void ProtectCanvasLibrary(Action<string> emit) =>
        emit("""
            ALTER TABLE canvas_library ENABLE ROW LEVEL SECURITY;
            ALTER TABLE canvas_library FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS canvas_library_tenant_isolation ON canvas_library;
            CREATE POLICY canvas_library_tenant_isolation ON canvas_library
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Bounds how large one principal's library JSON may be.
    /// </summary>
    /// <remarks>
    /// Matches <c>item_properties_bounded</c>'s shape and reasoning: an Excalidraw library item
    /// embeds its own SVG-shaped element data, and without a ceiling a pathological import turns
    /// one row into an unbounded write. 1 MiB comfortably holds a library of a few hundred shapes,
    /// which is already generous for what one person curates by hand.
    /// </remarks>
    private static void BoundLibrarySize(Action<string> emit) =>
        emit("""
            ALTER TABLE canvas_library ADD CONSTRAINT canvas_library_items_bounded
                CHECK (octet_length(library_items::text) <= 1048576);
            """);
}
