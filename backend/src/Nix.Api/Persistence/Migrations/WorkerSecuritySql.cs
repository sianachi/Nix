namespace Nix.Persistence.Migrations;

/// <summary>RLS and least-privilege grants for the backend-owned worker tables.</summary>
public static class WorkerSecuritySql
{
    /// <summary>Applies tenant isolation and runtime grants.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in new[] { "worker_job", "worker_outbox_event" })
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO nix_app;
                """);
        }
    }

    /// <summary>Removes policies and runtime grants before dropping the tables.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in new[] { "worker_job", "worker_outbox_event" })
        {
            emit($"""
                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                REVOKE ALL ON {table} FROM nix_app;
                """);
        }
    }
}
