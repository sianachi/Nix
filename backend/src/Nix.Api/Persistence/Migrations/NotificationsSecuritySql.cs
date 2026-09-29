namespace Nix.Persistence.Migrations;

/// <summary>
/// Principal and tenant isolation for reminder preferences, the inbox and registered push
/// devices - exactly the read/write policy <c>pet_preferences</c> uses, applied to all three
/// tables this migration creates.
/// </summary>
public static class NotificationsSecuritySql
{
    /// <summary>Applies fail-closed read and write policies to each table.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in new[] { "principal_preferences", "notification", "push_subscription" })
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
                CREATE POLICY {table}_owner ON {table}
                USING (
                    tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                    AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                )
                WITH CHECK (
                    tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                    AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                );
                """);
        }
    }
}
