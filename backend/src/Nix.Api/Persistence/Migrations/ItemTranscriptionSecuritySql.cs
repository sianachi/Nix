namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for <c>item_transcription</c> (ADR-0059): tenant isolation, the
/// grants, and the bounds on what a row may hold.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it, like every other file of this kind: a later phase
/// writes its own equivalent rather than editing this one.
/// </remarks>
internal static class ItemTranscriptionSecuritySql
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

        Protect(emit);
        Grant(emit);
        Bound(emit);
    }

    /// <summary>Undoes what <see cref="Apply"/> can outlive; the table goes with the generated Down.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP POLICY IF EXISTS item_transcription_tenant_isolation ON item_transcription;
            """);
    }

    /// <summary>
    /// Puts the tenant isolation policy on the table.
    /// </summary>
    /// <remarks>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the owner is subject to it too. Tenant isolation is the boundary
    /// this policy draws; who within the tenant may see a recording's status is decided by Core
    /// against the audio item before the row is read.
    /// </remarks>
    private static void Protect(Action<string> emit) =>
        emit("""
            ALTER TABLE item_transcription ENABLE ROW LEVEL SECURITY;
            ALTER TABLE item_transcription FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS item_transcription_tenant_isolation ON item_transcription;
            CREATE POLICY item_transcription_tenant_isolation ON item_transcription
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Full DML for Core, and nothing for anybody else.
    /// </summary>
    /// <remarks>
    /// Stated rather than inherited, because the database seed's <c>ALTER DEFAULT PRIVILEGES</c>
    /// makes grants fail open. The collaboration service appends the transcript, but it learns
    /// what it may write from Core's authorization answer and never from this table, so it holds
    /// no grant here.
    /// </remarks>
    private static void Grant(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON item_transcription FROM PUBLIC;
            REVOKE ALL ON item_transcription FROM {CollaborationRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON item_transcription TO {ApplicationRole};
            """);

    /// <summary>
    /// Bounds the two columns a worker or a request supplies.
    /// </summary>
    /// <remarks>
    /// Core validates both before writing. The constraints are the backstop that makes a row a
    /// status read can trust without re-validating: a percentage is a percentage, and the speaker
    /// mode is one of the two the worker understands.
    /// </remarks>
    private static void Bound(Action<string> emit) =>
        emit("""
            ALTER TABLE item_transcription ADD CONSTRAINT item_transcription_progress_bounded
                CHECK (progress BETWEEN 0 AND 100);
            ALTER TABLE item_transcription ADD CONSTRAINT item_transcription_speakers_known
                CHECK (speakers IN ('channels', 'none'));
            """);
}
