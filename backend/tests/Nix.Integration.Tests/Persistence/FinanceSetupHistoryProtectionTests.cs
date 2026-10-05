using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Finance;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Finance setup writes preserve figures and records for months that have been closed.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class FinanceSetupHistoryProtectionTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
    private static readonly YearMonth August = new(2026, 8);

    public FinanceSetupHistoryProtectionTests(NixPostgresFixture fixture) => _fixture = fixture;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Closed_month_settings_accounts_and_lines_are_protected_but_future_plan_edits_are_allowed()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 1000m, 3m, "UTC")),
                Cancellation);
            Assert.True(configured.IsSuccess, configured.IsSuccess ? "" : configured.Error.Message);

            var current = await CreateAccountAsync(dispatcher, root.Id,
                new FinanceAccountRequest("Current", "current", null, 0m, null, null, null, null, null));
            var reserve = await CreateAccountAsync(dispatcher, root.Id,
                new FinanceAccountRequest("Reserve", "current", null, 0m, null, null, null, null, null));
            var card = await CreateAccountAsync(dispatcher, root.Id,
                new FinanceAccountRequest("Card", "credit_card", 5000m, 200m, current.Id, null, null, null, null));
            var line = await CreateLineAsync(dispatcher, root.Id,
                new BudgetLineRequest("Groceries", "Food", "expense", card.Id, 60m,
                    new Dictionary<string, decimal> { ["2026-09"] = 40m }, false, null, null));
            var transaction = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id,
                    new FinanceTransactionRequest("Market", new DateOnly(2026, 8, 12), -20m, card.Id, line.Id)),
                Cancellation);
            Assert.True(transaction.IsSuccess, transaction.IsSuccess ? "" : transaction.Error.Message);

            var closed = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, August, new FinanceMonthRequest(true)),
                Cancellation);
            Assert.True(closed.IsSuccess, closed.IsSuccess ? "" : closed.Error.Message);

            var rebased = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-09", 3, 1000m, 3m, "UTC")),
                Cancellation);
            AssertClosedHistory(rebased);

            var repriced = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("USD", "2026-08", 3, 1001m, 2m, "UTC")),
                Cancellation);
            AssertClosedHistory(repriced);

            var changedCardType = await dispatcher.SendAsync<SetFinanceAccount, FinanceAccountResponse>(
                new SetFinanceAccount(root.Id, card.Id,
                    new FinanceAccountRequest("Card", "savings", null, 0m, null, null, null, null, null)),
                Cancellation);
            AssertClosedHistory(changedCardType);

            var changedOpening = await dispatcher.SendAsync<SetFinanceAccount, FinanceAccountResponse>(
                new SetFinanceAccount(root.Id, card.Id,
                    new FinanceAccountRequest("Card", "credit_card", 5000m, 201m, current.Id, null, null, null, null)),
                Cancellation);
            AssertClosedHistory(changedOpening);

            var changedSettlement = await dispatcher.SendAsync<SetFinanceAccount, FinanceAccountResponse>(
                new SetFinanceAccount(root.Id, card.Id,
                    new FinanceAccountRequest("Card", "credit_card", 5000m, 200m, reserve.Id, null, null, null, null)),
                Cancellation);
            AssertClosedHistory(changedSettlement);

            var newAccountWithOpening = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id,
                    new FinanceAccountRequest("Late account", "current", null, 100m, null, null, null, null, null)),
                Cancellation);
            AssertClosedHistory(newAccountWithOpening);

            var reclassified = await dispatcher.SendAsync<SetBudgetLine, BudgetLineResponse>(
                new SetBudgetLine(root.Id, line.Id,
                    new BudgetLineRequest("Groceries", "Food", "income", current.Id, 60m, null, false, null, null)),
                Cancellation);
            AssertClosedHistory(reclassified);

            var changedClosedPlan = await dispatcher.SendAsync<SetBudgetLine, BudgetLineResponse>(
                new SetBudgetLine(root.Id, line.Id,
                    new BudgetLineRequest("Groceries", "Food", "expense", card.Id, 61m,
                        new Dictionary<string, decimal> { ["2026-09"] = 40m }, false, null, null)),
                Cancellation);
            AssertClosedHistory(changedClosedPlan);

            var futurePlan = await dispatcher.SendAsync<SetBudgetLine, BudgetLineResponse>(
                new SetBudgetLine(root.Id, line.Id,
                    new BudgetLineRequest("Food", "Kitchen", "expense", card.Id, 60m,
                        new Dictionary<string, decimal> { ["2026-09"] = 50m }, false, null, null)),
                Cancellation);
            Assert.True(futurePlan.IsSuccess, futurePlan.IsSuccess ? "" : futurePlan.Error.Message);
            Assert.Equal("Food", futurePlan.Value.Name);
            Assert.Equal(50m, futurePlan.Value.Overrides["2026-09"]);

            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Configured_root_with_missing_history_metadata_or_containers_is_not_reinitialized()
    {
        ItemId rootId;
        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);
            rootId = root.Id;
            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")),
                Cancellation);
            Assert.True(configured.IsSuccess, configured.IsSuccess ? "" : configured.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        var childCount = await CountChildrenAsync(rootId);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null,
                $"UPDATE item SET properties = properties - '$fin_closed_months' WHERE id = '{rootId.Value:D}'::uuid");
        }

        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var missingHistory = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(rootId, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")),
                Cancellation);
            Assert.True(missingHistory.IsFailure);
            Assert.Equal("finance.invalid_closed_months", missingHistory.Error.Code);
        }

        connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null,
                $"""
                UPDATE item
                SET properties = jsonb_set(properties, ARRAY['$fin_closed_months'], '[]'::jsonb, true)
                    - '$fin_accounts_id'
                WHERE id = '{rootId.Value:D}'::uuid
                """);
        }

        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var missingContainers = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(rootId, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")),
                Cancellation);
            Assert.True(missingContainers.IsFailure);
            Assert.Equal("finance.not_configured", missingContainers.Error.Code);
        }

        Assert.Equal(childCount, await CountChildrenAsync(rootId));
    }

    private async Task<long> CountChildrenAsync(ItemId rootId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null,
                $"SELECT count(*) FROM item WHERE parent_id = '{rootId.Value:D}'::uuid");
        }
    }

    private static void AssertClosedHistory<T>(Result<T> result)
    {
        Assert.True(result.IsFailure);
        Assert.Equal("finance.closed_history", result.Error.Code);
    }

    private static async Task<Item> CreateRootAsync(NixDispatcher dispatcher)
    {
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Workspace, "note", "Finances", null, null), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }

    private static async Task<FinanceAccountResponse> CreateAccountAsync(
        NixDispatcher dispatcher,
        ItemId rootId,
        FinanceAccountRequest account)
    {
        var created = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
            new CreateFinanceAccount(rootId, account), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }

    private static async Task<BudgetLineResponse> CreateLineAsync(
        NixDispatcher dispatcher,
        ItemId rootId,
        BudgetLineRequest line)
    {
        var created = await dispatcher.SendAsync<CreateBudgetLine, BudgetLineResponse>(
            new CreateBudgetLine(rootId, line), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }
}
