using System.Globalization;
using System.Text;
using Nix.Abstractions;

namespace Nix.Persistence.Rls;

/// <summary>
/// Builds the SQL that publishes a <see cref="NixSessionContext"/> to Postgres as the session
/// settings the row-level security policies read.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every statement this type emits is <c>SET LOCAL</c>. That is the whole point of the type.</b>
/// <c>SET LOCAL</c> is scoped to the enclosing transaction and is unwound at COMMIT or ROLLBACK.
/// A plain <c>SET</c> is scoped to the <i>session</i>, which with Npgsql connection pooling means
/// the physical connection: the value survives the transaction, survives the connection being
/// returned to the pool in configurations where the reset is disabled or a transaction-pooling
/// proxy sits in between, and is then read by whatever unit of work leases that connection next.
/// The next unit of work belongs to a different customer. That is a cross-tenant data leak, not a
/// stale-cache bug, so the prefix is asserted here at build time rather than trusted to review.
/// </para>
/// <para>
/// The settings are emitted as literals rather than parameters because <c>SET LOCAL</c> does not
/// accept parameters. That is safe here and only here: every value is a <see cref="Guid"/>
/// rendered with the "D" format, whose alphabet is hexadecimal digits and hyphens. There is no
/// input through which a quote could reach the statement. <see cref="AssertSafeValue"/> re-checks
/// that character-by-character so a future change of the identifier type cannot quietly turn this
/// into string concatenation of untrusted text.
/// </para>
/// <para>
/// This type is public because the emitted text is a security assertion, and the integration
/// suite asserts on it directly.
/// </para>
/// </remarks>
public static class RlsSessionCommand
{
    /// <summary>The only statement form this type may emit.</summary>
    public const string SetLocalPrefix = "SET LOCAL ";

    /// <summary>Session setting holding the tenant every accessible row must belong to.</summary>
    public const string TenantSetting = "nix.tenant_id";

    /// <summary>Session setting holding the workspace in scope, empty when tenant-wide.</summary>
    public const string WorkspaceSetting = "nix.workspace_id";

    /// <summary>Session setting holding the acting principal.</summary>
    public const string PrincipalSetting = "nix.principal_id";

    /// <summary>
    /// The value written to <see cref="WorkspaceSetting"/> when no workspace is in scope.
    /// Policies must read it as <c>NULLIF(current_setting('nix.workspace_id', true), '')</c>:
    /// an empty string means "not narrowed to a workspace", never "workspace with no id".
    /// </summary>
    public const string NoWorkspace = "";

    /// <summary>
    /// Builds the transaction-local session-context statements for <paramref name="context"/>.
    /// </summary>
    /// <param name="context">The scope the enclosing transaction runs under.</param>
    /// <returns>
    /// One newline-separated batch of <c>SET LOCAL</c> statements, sent as a single command so the
    /// whole context costs one round trip per transaction.
    /// </returns>
    /// <exception cref="ArgumentException">
    /// <paramref name="context"/> is incomplete. An incomplete context must never reach the
    /// database: writing the nil UUID would publish a tenant that policies would then match rows
    /// against, so the failure has to happen here.
    /// </exception>
    public static string Build(NixSessionContext context)
    {
        if (!context.IsComplete)
        {
            throw new ArgumentException(
                "The session context is incomplete. A unit of work must carry a real tenant and " +
                "principal before it touches the database; publishing the nil UUID would make " +
                "row-level security match against a tenant that does not exist.",
                nameof(context));
        }

        var tenant = Format(context.TenantId.Value);
        var workspace = context.WorkspaceId is { } workspaceId ? Format(workspaceId.Value) : NoWorkspace;
        var principal = Format(context.PrincipalId.Value);

        // Three statements of 55-ish characters each; 192 keeps the batch on one buffer.
        var batch = new StringBuilder(192);
        AppendSetLocal(batch, TenantSetting, tenant);
        AppendSetLocal(batch, WorkspaceSetting, workspace);
        AppendSetLocal(batch, PrincipalSetting, principal);
        return batch.ToString();
    }

    /// <summary>
    /// Throws unless every non-empty line of <paramref name="commandText"/> begins with
    /// <see cref="SetLocalPrefix"/>.
    /// </summary>
    /// <param name="commandText">The batch about to be executed.</param>
    /// <exception cref="InvalidOperationException">
    /// Some statement is not a <c>SET LOCAL</c>. Executing it would put session-scoped state on a
    /// pooled physical connection.
    /// </exception>
    /// <remarks>
    /// Called by the interceptor immediately before execution, so the guard sits on the path the
    /// database actually sees rather than on the path a test happens to call.
    /// </remarks>
    public static void AssertOnlySetLocal(string commandText)
    {
        ArgumentNullException.ThrowIfNull(commandText);

        foreach (var line in commandText.AsSpan().EnumerateLines())
        {
            var statement = line.Trim();
            if (statement.IsEmpty)
            {
                continue;
            }

            if (!statement.StartsWith(SetLocalPrefix, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Refusing to publish the RLS session context: the statement '{statement}' is " +
                    $"not a '{SetLocalPrefix}' statement. A session-scoped SET survives the " +
                    "transaction on a pooled Npgsql connection and leaks this tenant's context " +
                    "into the next unit of work that leases it.");
            }
        }
    }

    private static void AppendSetLocal(StringBuilder batch, string setting, string value)
    {
        AssertSafeValue(setting, value);
        batch.Append(SetLocalPrefix).Append(setting).Append(" = '").Append(value).Append("';\n");
    }

    private static string Format(Guid id) => id.ToString("D", CultureInfo.InvariantCulture);

    /// <summary>
    /// Rejects any character outside the "D"-formatted UUID alphabet.
    /// </summary>
    /// <remarks>
    /// Redundant today by construction, and deliberately kept: the day someone widens a session
    /// setting to carry a string, this is what stops a quote from closing the literal.
    /// </remarks>
    private static void AssertSafeValue(string setting, string value)
    {
        foreach (var character in value)
        {
            var safe = character is (>= '0' and <= '9') or (>= 'a' and <= 'f') or '-';
            if (!safe)
            {
                throw new InvalidOperationException(
                    $"Refusing to publish the RLS session context: the value for '{setting}' " +
                    "contains a character outside the UUID alphabet. Session settings are " +
                    "emitted as SQL literals and may only ever carry identifiers.");
            }
        }
    }
}
