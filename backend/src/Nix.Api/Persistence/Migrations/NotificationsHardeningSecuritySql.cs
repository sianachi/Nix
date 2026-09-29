namespace Nix.Persistence.Migrations;

/// <summary>
/// Isolation and explicit grants for the notification tables: the inbox revision counter gets the
/// same principal-scoped policy as the other three, and every table's grants are stated here
/// instead of inherited from the seed's default privileges.
/// </summary>
public static class NotificationsHardeningSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Applies the inbox counter policy and narrows grants on all four tables.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE notification_inbox ENABLE ROW LEVEL SECURITY;
            ALTER TABLE notification_inbox FORCE ROW LEVEL SECURITY;
            CREATE POLICY notification_inbox_owner ON notification_inbox
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            """);

        // Full DML for the application role only (retention deletes notifications, removing a
        // device deletes its subscription, account purge cascades); nothing for anyone else,
        // including the collaboration role.
        foreach (var table in new[] { "principal_preferences", "notification", "push_subscription", "notification_inbox" })
        {
            emit($"""
                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ApplicationRole};
                """);
        }
    }
}
