using System.Net;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Backup status is instance-wide, so the gate fails closed: only principals listed in
/// <c>Nix:Sites:Operators</c> pass, and an empty list means nobody, tenant administrators included.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class BackupHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await SiteScenario.SeedPeopleAsync(fixture);
        var connection = await fixture.OpenSuperuserConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, "SET ROLE nix_backup");
            await RawSql.ExecuteAsync(connection, null, """
                SELECT nix_record_backup_run('2026-10-13T01:00:00Z', '2026-10-13T01:05:00Z', 'local', 'succeeded', NULL, 2048, NULL);
                SELECT nix_record_backup_run('2026-10-14T01:00:00Z', '2026-10-14T01:01:00Z', 'offsite', 'failed', NULL, NULL, 'off-host push failed (exit 1)');
                """);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_listed_operator_reads_the_runs_newest_first_and_another_tenant_administrator_is_refused()
    {
        await using var host = SiteHttpHost.Create(fixture, new Dictionary<string, string?> { ["Nix:Sites:Operators:0"] = SiteScenario.Viewer.ToString() });
        var operatorToken = await host.TokenAsync(SiteScenario.ViewerContext);
        var administrator = await host.TokenAsync(SiteScenario.Manager);

        using (var listed = await host.SendAsync(HttpMethod.Get, "/api/v1/admin/backups", operatorToken))
        {
            Assert.Equal(HttpStatusCode.OK, listed.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(listed);
            var runs = body.RootElement.GetProperty("runs").EnumerateArray().ToArray();
            Assert.Equal(["offsite", "local"], runs.Select(run => run.GetProperty("step").GetString()));
            Assert.Equal("off-host push failed (exit 1)", runs[0].GetProperty("error").GetString());
            Assert.Equal(2048, runs[1].GetProperty("bytes").GetInt64());
        }

        using (var refused = await host.SendAsync(HttpMethod.Get, "/api/v1/admin/backups", administrator))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("admin.operator_required", await SiteHttpHost.ProblemCodeAsync(refused));
        }

        Assert.True(await OperatorFeatureAsync(host, operatorToken));
        Assert.False(await OperatorFeatureAsync(host, administrator));
    }

    [Fact]
    public async Task With_no_operators_listed_nobody_passes_not_even_a_tenant_administrator()
    {
        await using var host = SiteHttpHost.Create(fixture);
        var administrator = await host.TokenAsync(SiteScenario.Manager);
        var member = await host.TokenAsync(SiteScenario.EditorContext);

        foreach (var token in new[] { administrator, member })
        {
            using var refused = await host.SendAsync(HttpMethod.Get, "/api/v1/admin/backups", token);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.False(await OperatorFeatureAsync(host, token));
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(101)]
    public async Task A_limit_outside_one_to_one_hundred_is_a_bad_request(int limit)
    {
        await using var host = SiteHttpHost.Create(fixture, new Dictionary<string, string?> { ["Nix:Sites:Operators:0"] = SiteScenario.Viewer.ToString() });
        var operatorToken = await host.TokenAsync(SiteScenario.ViewerContext);

        using var refused = await host.SendAsync(HttpMethod.Get, $"/api/v1/admin/backups?limit={limit}", operatorToken);

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
    }

    private static async Task<bool> OperatorFeatureAsync(SiteHttpHost host, string bearer)
    {
        using var me = await host.SendAsync(HttpMethod.Get, "/api/v1/me", bearer);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        using var body = await SiteHttpHost.JsonAsync(me);
        return body.RootElement.GetProperty("features").GetProperty("operator").GetBoolean();
    }
}
