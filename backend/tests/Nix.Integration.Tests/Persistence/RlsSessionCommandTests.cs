using Nix.Application.Persistence;
using Nix.Infrastructure.Persistence.Rls;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Asserts the exact text the RLS session interceptor sends. No database: the point is the
/// statement form, and it must be pinned somewhere that fails in milliseconds.
/// </summary>
public sealed class RlsSessionCommandTests
{
    // Raw, because the assertions below format them into the expected statement text with the
    // "D" specifier - which is exactly what the production code emits.
    private static readonly Guid Tenant = new("11111111-1111-4111-8111-111111111111");
    private static readonly Guid Workspace = new("1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a");
    private static readonly Guid Principal = new("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b");

    private static NixSessionContext WorkspaceScoped =>
        TestTenants.ContextFor(Tenant, Workspace, Principal);

    [Fact]
    public void Every_emitted_statement_is_a_set_local()
    {
        var commandText = RlsSessionCommand.Build(WorkspaceScoped);

        var statements = commandText
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        Assert.NotEmpty(statements);
        Assert.All(statements, statement =>
            Assert.StartsWith("SET LOCAL ", statement, StringComparison.Ordinal));
    }

    [Fact]
    public void No_emitted_statement_is_a_session_scoped_set()
    {
        var commandText = RlsSessionCommand.Build(WorkspaceScoped);

        // The failure this guards against is one missing word. A session-scoped SET on a pooled
        // connection outlives the transaction and is read by the next tenant to lease it.
        Assert.DoesNotContain("\nSET nix.", "\n" + commandText, StringComparison.Ordinal);
    }

    [Fact]
    public void All_three_session_settings_are_published()
    {
        var commandText = RlsSessionCommand.Build(WorkspaceScoped);

        Assert.Contains($"SET LOCAL nix.tenant_id = '{Tenant:D}';", commandText, StringComparison.Ordinal);
        Assert.Contains($"SET LOCAL nix.workspace_id = '{Workspace:D}';", commandText, StringComparison.Ordinal);
        Assert.Contains($"SET LOCAL nix.principal_id = '{Principal:D}';", commandText, StringComparison.Ordinal);
    }

    [Fact]
    public void A_tenant_wide_context_publishes_an_empty_workspace_rather_than_omitting_it()
    {
        var commandText = RlsSessionCommand.Build(TestTenants.ContextFor(Tenant, workspaceId: null, Principal));

        // Omitting the setting would leave whatever the previous transaction on this connection
        // put there. An empty string is an explicit "no workspace in scope".
        Assert.Contains("SET LOCAL nix.workspace_id = '';", commandText, StringComparison.Ordinal);
    }

    [Fact]
    public void An_incomplete_context_is_refused_rather_than_published_as_the_nil_uuid()
    {
        var noTenant = TestTenants.ContextFor(Guid.Empty, Workspace, Principal);

        Assert.Throws<ArgumentException>(() => RlsSessionCommand.Build(noTenant));
    }

    [Fact]
    public void A_context_with_no_principal_is_refused()
    {
        var noPrincipal = TestTenants.ContextFor(Tenant, Workspace, Guid.Empty);

        Assert.Throws<ArgumentException>(() => RlsSessionCommand.Build(noPrincipal));
    }

    [Fact]
    public void The_guard_rejects_a_batch_containing_a_session_scoped_set()
    {
        const string smuggled = """
            SET LOCAL nix.tenant_id = '11111111-1111-4111-8111-111111111111';
            SET nix.principal_id = '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b';
            """;

        var failure = Assert.Throws<InvalidOperationException>(
            () => RlsSessionCommand.AssertOnlySetLocal(smuggled));

        Assert.Contains("SET LOCAL", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_guard_accepts_a_batch_of_only_set_local_statements()
    {
        var commandText = RlsSessionCommand.Build(WorkspaceScoped);

        RlsSessionCommand.AssertOnlySetLocal(commandText);
    }
}
