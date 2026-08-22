using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The two folds honour derived item visibility and tenancy inside their bulk read.
/// </summary>
/// <remarks>
/// <para>
/// <b>The disclosure this exists to prevent, found in the security review of goal 2.2.</b> A
/// listing may ask for deleted items (<c>?includeDeleted=true</c> is an ordinary read), so a page
/// can carry a deleted container. Its children are themselves active, so a fold filtering only the
/// child's own lifecycle would answer count, sum, minimum, maximum and average over rows every
/// other endpoint refuses - a point read of one is a 404 and listing them is a refused parent. A
/// minimum and a maximum are not counts; they are exact stored values of particular hidden rows.
/// </para>
/// <para>
/// <b>The tenant cases are constructed so they can fail.</b> Beta's container has children of its
/// own and Alpha asks for Beta's parent by id, so the assertion rests on the tenant predicate and
/// the row-security policy rather than on the corpus making a match impossible - which is the
/// defect the review found in the first version of the plan-evidence test.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class RollupAuthorizationTests : IAsyncLifetime
{
    private static readonly Guid DeletedAncestor = new("201100f0-1111-4111-8111-201100f00001");
    private static readonly Guid HiddenContainer = new("201100f0-1111-4111-8111-201100f00002");
    private static readonly Guid HiddenChild = new("201100f0-1111-4111-8111-201100f00003");
    private static readonly Guid VisibleContainer = new("201100f0-1111-4111-8111-201100f00004");
    private static readonly Guid VisibleChild = new("201100f0-1111-4111-8111-201100f00005");
    private static readonly Guid BetaContainer = new("201100f0-2222-4222-8222-201100f00006");
    private static readonly Guid BetaChild = new("201100f0-2222-4222-8222-201100f00007");

    private readonly NixPostgresFixture _fixture;

    public RollupAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("deleted", false)]
    [InlineData("purged", false)]
    [InlineData("provisioning", false)]
    [InlineData("active", true)]
    public async Task A_container_below_a_non_visible_ancestor_folds_to_nothing(
        string ancestorLifecycle,
        bool templateOwned)
    {
        await SetAncestorBoundaryAsync(ancestorLifecycle, templateOwned);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(HiddenContainer), ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            // The visible container answers, so the read is working and the absence below is a
            // refusal rather than an empty result.
            var visible = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);
            Assert.Equal(1, visible.Children);
            Assert.Equal(7m, visible.Total);

            Assert.DoesNotContain(
                new ChildAggregateKey(ItemId.From(HiddenContainer), "estimate"),
                folds);
        }
    }

    [Fact]
    public async Task A_container_whose_own_lifecycle_is_not_active_folds_to_nothing()
    {
        // The direct case, not the inherited one: the parent itself is what a page carrying
        // ?includeDeleted=true hands the fold.
        await SetLifecycleAsync(VisibleContainer, "deleted");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            Assert.Empty(folds);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_fold_a_container_it_names_by_id()
    {
        // Beta's container really does have a child carrying the folded property, so a match is
        // possible and only the tenant predicate and the policy prevent it.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                [ItemId.From(BetaContainer)],
                ["estimate"],
                Cancellation);

            Assert.Empty(folds);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_bucket_a_container_it_names_by_id()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var buckets = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                ItemId.From(BetaContainer),
                "status",
                measureKey: "estimate",
                limit: 10,
                Cancellation);

            Assert.Empty(buckets.Buckets);
            Assert.Equal(0, buckets.Children);
        }
    }

    [Fact]
    public async Task A_container_below_a_non_visible_ancestor_buckets_to_nothing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var hidden = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(HiddenContainer),
                "status",
                measureKey: null,
                limit: 10,
                Cancellation);

            Assert.Empty(hidden.Buckets);

            // The visible one answers, so the emptiness above is a refusal rather than a read that
            // does not work.
            var visible = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "status",
                measureKey: null,
                limit: 10,
                Cancellation);

            Assert.Equal(1, visible.Children);
        }
    }

    [Fact]
    public async Task A_number_too_large_to_represent_is_not_counted_rather_than_fatal()
    {
        // Measured in the review of goal 2.2: `PropertyValidator` accepts anything that reads as a
        // double, so 1e308 is a legal write - and Postgres numeric is arbitrary precision where
        // System.Decimal is not. Unbounded, this read threw OverflowException, and the blast radius
        // was the whole listing of the container as an opaque 500. One person, one number.
        await SetPropertiesAsync(VisibleChild, "{\"title\":\"Visible child\",\"estimate\":1e308}");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            var fold = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);

            // The child is still a child and still carries a value; the value is simply not one
            // the fold can reduce, which is the posture a value of the wrong kind already gets.
            Assert.Equal(1, fold.Children);
            Assert.Equal(1, fold.Present);
            Assert.Equal(0, fold.Numbers);
            Assert.Null(fold.Total);
            Assert.Null(fold.Smallest);
        }
    }

    [Fact]
    public async Task An_ordinary_large_total_is_still_answered()
    {
        // The other half of the bound: it has to admit a total a real workspace could reach. Two
        // hundred and one children at 1e15 each total 2.01e17, well inside what a decimal holds.
        await SetPropertiesAsync(VisibleChild, "{\"title\":\"a\",\"estimate\":1000000000000000}");
        await AddChildrenWithEstimateAsync(VisibleContainer, 200);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            var fold = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);

            Assert.Equal(201, fold.Numbers);
            Assert.Equal(201_000_000_000_000_000m, fold.Total);
        }
    }

    private async Task SetPropertiesAsync(Guid id, string properties)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET properties = '{properties}'::jsonb WHERE id = {Literal(id)};");
        }
    }

    private async Task AddChildrenWithEstimateAsync(Guid parent, int count)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item
                      (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                       lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                       last_modified_at)
                  SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', {{Literal(parent)}},
                         900000 + n,
                         jsonb_build_object('title', 'Big ' || n, 'estimate', 1000000000000000::numeric),
                         'active', NULL, {{principal}}, {{principal}}, now(), now()
                  FROM generate_series(1, {{count}}) AS n;

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE seq >= 900001;

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, {{Literal(parent)}}, tenant_id, workspace_id, 1
                  FROM item WHERE seq >= 900001;
                  """);
        }
    }

    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaTenant = Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 'note', NULL, 1000,
                 '{"title":"Deleted ancestor"}'::jsonb, 'deleted', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(DeletedAncestor)}}, 2000, '{"title":"Hidden container"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(HiddenContainer)}}, 3000,
                 '{"title":"Hidden child","estimate":13,"status":"Doing"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 'note', NULL, 4000,
                 '{"title":"Visible container"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(VisibleContainer)}}, 5000,
                 '{"title":"Visible child","estimate":7,"status":"Todo"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 'note', NULL, 6000,
                 '{"title":"Other tenant container"}'::jsonb,
                 'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()),
                ({{Literal(BetaChild)}}, {{betaTenant}}, {{betaWorkspace}}, 'note',
                 {{Literal(BetaContainer)}}, 7000,
                 '{"title":"Other tenant child","estimate":99,"status":"Done"}'::jsonb,
                 'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now());

            INSERT INTO item_closure
                (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{Literal(DeletedAncestor)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenContainer)}}, {{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenContainer)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(HiddenChild)}}, {{Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenChild)}}, {{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(HiddenChild)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 2),
                ({{Literal(VisibleContainer)}}, {{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(BetaContainer)}}, {{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 0),
                ({{Literal(BetaChild)}}, {{Literal(BetaChild)}}, {{betaTenant}}, {{betaWorkspace}}, 0),
                ({{Literal(BetaChild)}}, {{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 1);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task SetAncestorBoundaryAsync(string lifecycle, bool templateOwned)
    {
        var template = templateOwned ? Literal(M0SchemaSeed.Alpha.TemplateId) : "NULL";
        var source = templateOwned ? Literal(DeletedAncestor) : "NULL";

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item
                     SET lifecycle_state = '{{lifecycle}}',
                         template_id = {{template}},
                         template_source_id = {{source}}
                   WHERE id = {{Literal(DeletedAncestor)}};
                  """);
        }
    }

    private async Task SetLifecycleAsync(Guid id, string lifecycle)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item SET lifecycle_state = '{{lifecycle}}' WHERE id = {{Literal(id)}};
                  """);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
