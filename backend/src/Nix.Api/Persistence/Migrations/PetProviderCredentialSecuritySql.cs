namespace Nix.Persistence.Migrations;

/// <summary>
/// Row security for <c>pet_provider_credential</c>: a principal reads and writes only their own
/// rows, through the application role alone. Mirrors <c>principal_preferences</c>.
/// </summary>
public static class PetProviderCredentialSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Enables and forces RLS with the owner policy, and grants the application role its DML.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($"""
            ALTER TABLE pet_provider_credential ENABLE ROW LEVEL SECURITY;
            ALTER TABLE pet_provider_credential FORCE ROW LEVEL SECURITY;
            CREATE POLICY pet_provider_credential_owner ON pet_provider_credential
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON pet_provider_credential FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON pet_provider_credential TO {ApplicationRole};
            """);
    }
}
