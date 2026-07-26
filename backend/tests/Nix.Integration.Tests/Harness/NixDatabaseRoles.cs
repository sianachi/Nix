namespace Nix.Integration.Tests.Harness;

/// <summary>
/// The two database roles of the security model, and the SQL that provisions them.
/// </summary>
/// <remarks>
/// <para>
/// Kept deliberately in step with <c>deploy/seed/seed.sql</c> and
/// <c>deploy/seed/seed_database.sql</c>. If the two ever drift, the integration suite stops
/// describing the database the application actually runs against, and a test that proves
/// isolation here would prove nothing about production. Any change to the deploy seed belongs
/// here in the same commit.
/// </para>
/// <para>
/// The load-bearing attribute is <c>NOBYPASSRLS</c> on the application role. A role with
/// <c>BYPASSRLS</c> ignores every policy in the database, so isolation tests run under such a role
/// would pass while isolating nothing. <c>DatabaseRoleTests</c> asserts the attribute against
/// <c>pg_roles</c> before anything else is believed.
/// </para>
/// </remarks>
internal static class NixDatabaseRoles
{
    /// <summary>The runtime role. Cannot bypass RLS, cannot create objects.</summary>
    public const string Application = "nix_app";

    /// <summary>The schema owner. The only role holding BYPASSRLS.</summary>
    public const string Migrator = "nix_migrator";

    /// <summary>Password for both roles inside the disposable test container.</summary>
    public const string Password = "nix-test-password";

    /// <summary>The application database created inside the container.</summary>
    public const string Database = "nix";

    /// <summary>
    /// Cluster-level provisioning: the two roles and their attributes. Runs as the superuser
    /// against the maintenance database.
    /// </summary>
    public const string CreateRolesSql = $"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{Migrator}') THEN
                CREATE ROLE {Migrator} LOGIN PASSWORD '{Password}';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{Application}') THEN
                CREATE ROLE {Application} LOGIN PASSWORD '{Password}';
            END IF;
        END
        $$;

        ALTER ROLE {Migrator} WITH BYPASSRLS;
        ALTER ROLE {Application} WITH NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

        DO $$
        BEGIN
            IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = '{Application}') THEN
                RAISE EXCEPTION
                    'the harness provisioned {Application} with BYPASSRLS; every isolation test below would be meaningless';
            END IF;
        END
        $$;
        """;

    /// <summary>
    /// Database-level provisioning: extension, ownership, and grants. Runs as the superuser
    /// against the application database.
    /// </summary>
    /// <remarks>
    /// The default privileges are what give <c>nix_app</c> access to tables the migrator creates
    /// later - including the RLS probe table. Granting the probe explicitly instead would let a
    /// broken grant mechanism pass unnoticed.
    /// </remarks>
    public const string ConfigureDatabaseSql = $"""
        CREATE EXTENSION IF NOT EXISTS vector;

        ALTER SCHEMA public OWNER TO {Migrator};

        GRANT CONNECT ON DATABASE {Database} TO {Application}, {Migrator};
        GRANT USAGE ON SCHEMA public TO {Application};

        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        REVOKE CREATE ON SCHEMA public FROM {Application};

        ALTER DEFAULT PRIVILEGES FOR ROLE {Migrator} IN SCHEMA public
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {Application};
        ALTER DEFAULT PRIVILEGES FOR ROLE {Migrator} IN SCHEMA public
            GRANT USAGE, SELECT ON SEQUENCES TO {Application};
        """;
}
