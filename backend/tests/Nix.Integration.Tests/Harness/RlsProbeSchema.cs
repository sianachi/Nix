namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A single test-only table with a tenant column and a row-level security policy.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is not domain schema and must never become any.</b> It exists so the persistence
/// mechanism can be proved before there is anything to store: a table with a <c>tenant_id</c> and
/// one policy is the smallest thing that can tell an isolating mechanism from a broken one. The
/// tenancy goal owns the real tables and will apply the same policy shape to each of them; when
/// it does, this table stays, because it keeps proving the mechanism independently of whatever
/// the domain schema happens to look like that month.
/// </para>
/// <para>
/// It is created by the migrator, as raw SQL, outside EF migrations - so it never appears in the
/// migration history and cannot be mistaken for production schema.
/// </para>
/// <para>
/// The policy shape is the one the tenancy goal should copy:
/// </para>
/// <list type="bullet">
///   <item>
///     <description>
///     <c>USING</c> and <c>WITH CHECK</c> both present. <c>USING</c> alone would hide other
///     tenants' rows on read while still allowing a write that plants a row under their tenant id.
///     </description>
///   </item>
///   <item>
///     <description>
///     <c>current_setting('nix.tenant_id', true)</c> - the <c>true</c> is <c>missing_ok</c>. With
///     it, an unset setting yields NULL, the comparison yields NULL, and no row qualifies: an
///     unscoped session sees nothing. Without it the statement raises instead, which is louder but
///     turns every unscoped read into a 500 rather than a fail-closed empty result.
///     </description>
///   </item>
///   <item>
///     <description>
///     <c>FORCE ROW LEVEL SECURITY</c>, so the table owner is subject to the policy too. Only the
///     <c>BYPASSRLS</c> attribute gets past it, and only <c>nix_migrator</c> holds that.
///     </description>
///   </item>
/// </list>
/// </remarks>
internal static class RlsProbeSchema
{
    /// <summary>The probe table's name.</summary>
    public const string TableName = "rls_probe";

    /// <summary>Creates the probe table and its policy. Applied as the migrator.</summary>
    public const string CreateSql = $"""
        CREATE TABLE IF NOT EXISTS {TableName} (
            id           uuid PRIMARY KEY,
            tenant_id    uuid NOT NULL,
            workspace_id uuid NULL,
            label        text NOT NULL,
            payload      bytea NOT NULL DEFAULT ''::bytea
        );

        ALTER TABLE {TableName} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE {TableName} FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS {TableName}_tenant_isolation ON {TableName};
        CREATE POLICY {TableName}_tenant_isolation ON {TableName}
            USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
        """;

    /// <summary>Inserts a probe row. Seeded as the migrator, on behalf of either tenant.</summary>
    public const string InsertSql = $"""
        INSERT INTO {TableName} (id, tenant_id, workspace_id, label, payload)
        VALUES (@id, @tenant_id, @workspace_id, @label, @payload)
        """;

    /// <summary>Reads every row the caller is allowed to see, newest label order.</summary>
    public const string SelectVisibleSql = $"""
        SELECT id, tenant_id, label
        FROM {TableName}
        ORDER BY label
        """;

    /// <summary>Counts the rows the caller is allowed to see.</summary>
    public const string CountVisibleSql = $"SELECT count(*) FROM {TableName}";

    /// <summary>
    /// Reads one row's binary payload, projected last so sequential access reaches it after the
    /// scalar columns.
    /// </summary>
    public const string SelectPayloadSql = $"""
        SELECT label, payload
        FROM {TableName}
        WHERE id = @id
        """;
}
