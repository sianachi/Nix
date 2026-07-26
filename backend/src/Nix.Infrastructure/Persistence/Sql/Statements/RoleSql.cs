namespace Nix.Infrastructure.Persistence.Sql.Statements;

/// <summary>
/// Statements about the role a connection is authenticated as.
/// </summary>
public static class RoleSql
{
    /// <summary>
    /// Returns the connected role's name and whether it can bypass row-level security.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>rolbypassrls</c> is the attribute that decides whether every RLS policy in the database
    /// is a boundary or a decoration. Exactly one role may hold it - <c>nix_migrator</c> - and the
    /// migration runner checks for it rather than trusting the connection string it was handed.
    /// </para>
    /// <para>
    /// Read for <c>current_user</c> rather than a supplied name so the answer describes the
    /// session actually in front of us. No index dependency: <c>pg_roles</c> is a catalogue view.
    /// </para>
    /// </remarks>
    public const string CurrentRoleBypassesRls = """
        SELECT rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user
        """;

    /// <summary>Returns the name of the connected role.</summary>
    public const string CurrentRoleName = "SELECT current_user";

    /// <summary>
    /// Returns whether the named role can bypass row-level security, or no row if it does not
    /// exist.
    /// </summary>
    /// <remarks>
    /// Used by the migration job to check the runtime role before it changes the schema. The
    /// migration job is the right place for that check: it is the one moment in a deployment when
    /// something with authority looks at the database, and a runtime role that has picked up
    /// <c>BYPASSRLS</c> should stop the rollout rather than serve traffic.
    /// </remarks>
    public const string RoleBypassesRlsByName = """
        SELECT rolbypassrls
        FROM pg_roles
        WHERE rolname = @role_name
        """;
}
