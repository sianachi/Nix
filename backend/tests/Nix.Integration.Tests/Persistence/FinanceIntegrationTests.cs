using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Finance;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Npgsql;
using NpgsqlTypes;
using Xunit.Sdk;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The finance module over the real PostgreSQL persistence boundary: set up, record, post, close, import.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class FinanceIntegrationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public FinanceIntegrationTests(NixPostgresFixture fixture, ITestOutputHelper output) => (_fixture, _output) = (fixture, output);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_root_is_set_up_recorded_against_posted_closed_and_imported_into()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);

            var unconfigured = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(root.Id), Cancellation);
            Assert.True(unconfigured.IsFailure);
            Assert.Equal("finance.not_configured", unconfigured.Error.Code);

            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("gbp", "2026-08", 17, 2000m, 3m, "Europe/London")), Cancellation);
            Assert.True(configured.IsSuccess, configured.IsSuccess ? "" : configured.Error.Message);
            Assert.Equal("GBP", configured.Value.Settings.Currency);
            Assert.Equal("2027-12", configured.Value.Settings.EndMonth);
            var containers = configured.Value.Containers;

            var again = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 17, 5000m, 3m, "Europe/London")), Cancellation);
            Assert.True(again.IsSuccess);
            Assert.Equal(containers, again.Value.Containers);
            Assert.Equal(5000m, again.Value.Settings.OpeningCash);

            var current = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("Example current account", "current", null, 2000m, null, null, null, null, null)), Cancellation);
            Assert.True(current.IsSuccess, current.IsSuccess ? "" : current.Error.Message);
            var card = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("PrimaryCard", "credit_card", 3000m, 100m, current.Value.Id, null, null, null, null)), Cancellation);
            Assert.True(card.IsSuccess, card.IsSuccess ? "" : card.Error.Message);
            var orphanCard = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("Nowhere card", "credit_card", null, 0m, Guid.NewGuid(), null, null, null, null)), Cancellation);
            Assert.True(orphanCard.IsFailure);
            Assert.Equal("finance.invalid_account", orphanCard.Error.Code);
            var loan = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("Loan", "loan", null, 6000m, null, 0.06m, 300m, 0m, null)), Cancellation);
            Assert.True(loan.IsSuccess, loan.IsSuccess ? "" : loan.Error.Message);

            var salary = await CreateLineAsync(dispatcher, root.Id, new BudgetLineRequest("Salary", "Income", "income", current.Value.Id, 4000m, null, true, 25, null));
            var rent = await CreateLineAsync(dispatcher, root.Id, new BudgetLineRequest("Rent", "Housing", "expense", current.Value.Id, 900m, null, true, 1, null));
            var repayment = await CreateLineAsync(dispatcher, root.Id, new BudgetLineRequest("Loan repayment", "Commitments", "expense", current.Value.Id, 0m, null, true, 3, loan.Value.Id));
            var groceries = await CreateLineAsync(dispatcher, root.Id, new BudgetLineRequest("Groceries", "PrimaryCard", "expense", card.Value.Id, 200m, new Dictionary<string, decimal> { ["2026-12"] = 300m }, false, null, null));
            var badLine = await dispatcher.SendAsync<CreateBudgetLine, BudgetLineResponse>(
                new CreateBudgetLine(root.Id, new BudgetLineRequest("Nothing", "Housing", "expense", loan.Value.Id, 1m, null, false, null, null)), Cancellation);
            Assert.True(badLine.IsFailure);
            Assert.Equal("finance.invalid_line", badLine.Error.Code);
            var creditCardIncome = await dispatcher.SendAsync<CreateBudgetLine, BudgetLineResponse>(
                new CreateBudgetLine(root.Id, new BudgetLineRequest("Card income", "Income", "income", card.Value.Id, 1m, null, false, null, null)), Cancellation);
            Assert.True(creditCardIncome.IsFailure);
            Assert.Equal("finance.invalid_line", creditCardIncome.Error.Code);

            var renamed = await dispatcher.SendAsync<SetBudgetLine, BudgetLineResponse>(
                new SetBudgetLine(root.Id, groceries.Id, new BudgetLineRequest("Food", "PrimaryCard", "expense", card.Value.Id, 220m, null, false, null, null)), Cancellation);
            Assert.True(renamed.IsSuccess, renamed.IsSuccess ? "" : renamed.Error.Message);
            Assert.Equal("Food", renamed.Value.Name);
            Assert.Equal(groceries.Position, renamed.Value.Position);

            var tesco = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Example shop", new DateOnly(2026, 8, 3), -59m, card.Value.Id, groceries.Id)), Cancellation);
            Assert.True(tesco.IsSuccess, tesco.IsSuccess ? "" : tesco.Error.Message);
            var wrongAccount = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Oops", new DateOnly(2026, 8, 3), -1m, loan.Value.Id, null)), Cancellation);
            Assert.True(wrongAccount.IsFailure);
            Assert.Equal("finance.invalid_transaction", wrongAccount.Error.Code);
            var mismatchedLine = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Wrong account for groceries", new DateOnly(2026, 8, 3), -1m, current.Value.Id, groceries.Id)), Cancellation);
            Assert.True(mismatchedLine.IsFailure);
            Assert.Equal("finance.invalid_transaction", mismatchedLine.Error.Code);

            var posted = await dispatcher.SendAsync<PostScheduledTransactions, PostScheduledResponse>(new PostScheduledTransactions(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8)), Cancellation);
            Assert.True(posted.IsSuccess, posted.IsSuccess ? "" : posted.Error.Message);
            Assert.Equal(3, posted.Value.Posted.Count);
            Assert.Contains(posted.Value.Posted, transaction => transaction.LineId == repayment.Id && transaction.Amount == -300m && transaction.Date == new DateOnly(2026, 8, 3));
            Assert.Contains(posted.Value.Posted, transaction => transaction.LineId == salary.Id && transaction.Amount == 4000m);
            var postedSalary = posted.Value.Posted.Single(transaction => transaction.LineId == salary.Id);
            var movedPost = await dispatcher.SendAsync<SetFinanceTransaction, FinanceTransactionResponse>(
                new SetFinanceTransaction(root.Id, postedSalary.Id, new FinanceTransactionRequest("Moved post", postedSalary.Date, postedSalary.Amount, current.Value.Id, rent.Id)), Cancellation);
            Assert.True(movedPost.IsFailure);
            Assert.Equal("finance.invalid_transaction", movedPost.Error.Code);
            var unassignedPost = await dispatcher.SendAsync<SetFinanceTransaction, FinanceTransactionResponse>(
                new SetFinanceTransaction(root.Id, postedSalary.Id, new FinanceTransactionRequest("Unassigned post", postedSalary.Date, postedSalary.Amount, current.Value.Id, null)), Cancellation);
            Assert.True(unassignedPost.IsFailure);
            Assert.Equal("finance.invalid_transaction", unassignedPost.Error.Code);
            var postedAgain = await dispatcher.SendAsync<PostScheduledTransactions, PostScheduledResponse>(new PostScheduledTransactions(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8)), Cancellation);
            Assert.True(postedAgain.IsSuccess);
            Assert.Empty(postedAgain.Value.Posted);
            Assert.Equal(3, postedAgain.Value.AlreadyPosted);

            var grid = await dispatcher.QueryAsync<ReadBudgetGrid, Result<BudgetGridResponse>>(
                new ReadBudgetGrid(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8), new Nix.Domain.Finance.YearMonth(2026, 12)), Cancellation);
            Assert.True(grid.IsSuccess, grid.IsSuccess ? "" : grid.Error.Message);
            var food = grid.Value.Sections.Single(section => section.Name == "PrimaryCard").Lines.Single();
            Assert.Equal(220m, food.Cells[0].Plan);
            Assert.Equal(59m, food.Cells[0].Actual);
            Assert.Equal(-161m, food.Cells[0].Variance);
            Assert.Equal(220m, food.Cells[4].Plan);
            Assert.Equal(4000m, grid.Value.Totals[0].Actual.Income);
            Assert.Equal(1200m, grid.Value.Totals[0].Actual.PaidThisMonth);
            Assert.Equal(59m, grid.Value.Totals[0].Actual.CardSpend);

            var checklist = await dispatcher.QueryAsync<ReadFinanceMonth, Result<MonthChecklistResponse>>(new ReadFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8)), Cancellation);
            Assert.True(checklist.IsSuccess);
            Assert.Equal(3, checklist.Value.ScheduledPosted);
            Assert.Equal(0, checklist.Value.ScheduledUnposted);

            var closed = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8), new FinanceMonthRequest(true)), Cancellation);
            Assert.True(closed.IsSuccess, closed.IsSuccess ? "" : closed.Error.Message);
            Assert.Equal(["2026-08"], closed.Value.ClosedMonths);
            var intoClosed = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Late", new DateOnly(2026, 8, 30), -1m, card.Value.Id, null)), Cancellation);
            Assert.True(intoClosed.IsFailure);
            Assert.Equal("finance.month_closed", intoClosed.Error.Code);

            var cashFlow = await dispatcher.QueryAsync<ReadCashFlow, Result<CashFlowResponse>>(new ReadCashFlow(root.Id), Cancellation);
            Assert.True(cashFlow.IsSuccess, cashFlow.IsSuccess ? "" : cashFlow.Error.Message);
            Assert.Equal("actual", cashFlow.Value.Months[0].Source);
            Assert.Equal("plan", cashFlow.Value.Months[1].Source);
            Assert.Equal(5000m + 4000m - 1200m - 100m, cashFlow.Value.Months[0].ClosingBank);
            Assert.Equal(59m, cashFlow.Value.Months[1].CardPaymentOut);

            var dashboard = await dispatcher.QueryAsync<ReadFinanceDashboard, Result<FinanceDashboardResponse>>(new ReadFinanceDashboard(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8)), Cancellation);
            Assert.True(dashboard.IsSuccess, dashboard.IsSuccess ? "" : dashboard.Error.Message);
            Assert.True(dashboard.Value.Closed);
            Assert.Single(dashboard.Value.Cards);
            Assert.Single(dashboard.Value.Loans);
            Assert.Equal(59m, dashboard.Value.CardFloat);

            var schedule = await dispatcher.QueryAsync<ReadLoanSchedule, Result<LoanScheduleResponse>>(new ReadLoanSchedule(root.Id, loan.Value.Id, 100m), Cancellation);
            Assert.True(schedule.IsSuccess, schedule.IsSuccess ? "" : schedule.Error.Message);
            Assert.Equal(22, schedule.Value.Baseline.MonthsToClear);
            Assert.Equal(16, schedule.Value.Alternative.MonthsToClear);
            Assert.Equal(6, schedule.Value.MonthsSaved);

            const string csv = "Date,Description,Amount\n2026-09-01,EXAMPLE SHOP,-12.40\n2026-09-01,EXAMPLE SHOP,-12.40\n2026-09-02,EXAMPLE CAFE,-3.20\nbroken,EXAMPLE CAFE,-3.20\n";
            var preview = await dispatcher.SendAsync<ImportFinanceStatement, FinanceImportResponse>(new ImportFinanceStatement(root.Id, new FinanceImportRequest(card.Value.Id, csv, false)), Cancellation);
            Assert.True(preview.IsSuccess, preview.IsSuccess ? "" : preview.Error.Message);
            Assert.Equal(2, preview.Value.Created);
            Assert.Equal(1, preview.Value.Duplicates);
            Assert.Equal(1, preview.Value.Unreadable);
            Assert.False(preview.Value.Committed);
            var otherAccountPreview = await dispatcher.SendAsync<ImportFinanceStatement, FinanceImportResponse>(
                new ImportFinanceStatement(root.Id, new FinanceImportRequest(current.Value.Id, "Date,Description,Amount\n2026-09-05,EXAMPLE SHOP,-7.00\n", false)), Cancellation);
            Assert.True(otherAccountPreview.IsSuccess, otherAccountPreview.IsSuccess ? "" : otherAccountPreview.Error.Message);
            Assert.Null(otherAccountPreview.Value.Preview.Single().SuggestedLineId);
            var manualExampleCafe = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Example cafe", new DateOnly(2026, 9, 2), -3.20m, card.Value.Id, groceries.Id)), Cancellation);
            Assert.True(manualExampleCafe.IsSuccess);
            var committed = await dispatcher.SendAsync<ImportFinanceStatement, FinanceImportResponse>(new ImportFinanceStatement(root.Id, new FinanceImportRequest(card.Value.Id, csv, true)), Cancellation);
            Assert.True(committed.IsSuccess, committed.IsSuccess ? "" : committed.Error.Message);
            Assert.Equal(1, committed.Value.Created);
            Assert.Equal(1, committed.Value.Matched);
            Assert.True(committed.Value.Committed);
            var reimported = await dispatcher.SendAsync<ImportFinanceStatement, FinanceImportResponse>(new ImportFinanceStatement(root.Id, new FinanceImportRequest(card.Value.Id, csv, true)), Cancellation);
            Assert.True(reimported.IsSuccess);
            Assert.Equal(0, reimported.Value.Created);
            Assert.Equal(0, reimported.Value.Matched);
            Assert.Equal(3, reimported.Value.Duplicates);

            var september = await dispatcher.QueryAsync<ListFinanceTransactions, Result<FinanceTransactionsResponse>>(
                new ListFinanceTransactions(root.Id, new Nix.Domain.Finance.YearMonth(2026, 9), null, null, false, 0), Cancellation);
            Assert.True(september.IsSuccess);
            Assert.Equal(2, september.Value.Total);
            Assert.All(september.Value.Transactions, transaction => Assert.True(transaction.Cleared));

            var futureCash = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("September rent", new DateOnly(2026, 9, 1), -88m, current.Value.Id, rent.Id)), Cancellation);
            Assert.True(futureCash.IsSuccess);
            var augustAccounts = await dispatcher.QueryAsync<ReadFinanceAccounts, Result<FinanceAccountsResponse>>(
                new ReadFinanceAccounts(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8)), Cancellation);
            Assert.True(augustAccounts.IsSuccess);
            Assert.Equal(4800m, augustAccounts.Value.Accounts.Single(summary => summary.Account.Id == current.Value.Id).RecordedBalance);

            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(tesco.Value.Id)), Cancellation);
            Assert.True(deleted.IsFailure);
            Assert.Equal("finance.month_closed", deleted.Error.Code);
            var reopenedAugust = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8), new FinanceMonthRequest(false)), Cancellation);
            Assert.True(reopenedAugust.IsSuccess);
            deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(tesco.Value.Id)), Cancellation);
            Assert.True(deleted.IsSuccess);
            var afterDelete = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(root.Id), Cancellation);
            Assert.True(afterDelete.IsSuccess);
            Assert.Equal(6, afterDelete.Value.TransactionCount);
            Assert.Empty(afterDelete.Value.Problems);
        }
    }

    [Fact]
    public async Task Finance_loader_rejects_foreign_containers_and_record_references()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var first = await CreateRootAsync(dispatcher);
            var second = await CreateRootAsync(dispatcher);
            var firstFinance = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(first.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")), Cancellation);
            var secondFinance = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(second.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")), Cancellation);
            Assert.True(firstFinance.IsSuccess);
            Assert.True(secondFinance.IsSuccess);

            var tree = work.Resolve<IItemTree>();
            await ForceRemovePropertyAsync(tree, first.Id, FinanceKeys.ClosedMonths);
            var missingClosures = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(first.Id), Cancellation);
            Assert.True(missingClosures.IsFailure);
            Assert.Equal("finance.invalid_closed_months", missingClosures.Error.Code);
            var blockedMissingClosureMutation = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(first.Id, "Changed root"), Cancellation);
            Assert.True(blockedMissingClosureMutation.IsFailure);
            Assert.Equal("finance.month_closed", blockedMissingClosureMutation.Error.Code);
            await ForcePropertiesAsync(tree, first.Id, new JsonObject { [FinanceKeys.ClosedMonths] = new JsonArray() });
            await ForcePropertiesAsync(tree, first.Id, new JsonObject { [FinanceKeys.TransactionsContainer] = secondFinance.Value.Containers.Transactions.ToString("D") });
            var invalidRoot = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(first.Id), Cancellation);
            Assert.True(invalidRoot.IsFailure);
            Assert.Equal("finance.not_configured", invalidRoot.Error.Code);

            await ForcePropertiesAsync(tree, first.Id, new JsonObject { [FinanceKeys.TransactionsContainer] = firstFinance.Value.Containers.Transactions.ToString("D") });
            await ForcePropertiesAsync(tree, first.Id, new JsonObject { [FinanceKeys.ClosedMonths] = "damaged" });
            var unreadableClosures = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(first.Id), Cancellation);
            Assert.True(unreadableClosures.IsFailure);
            Assert.Equal("finance.invalid_closed_months", unreadableClosures.Error.Code);
            await ForcePropertiesAsync(tree, first.Id, new JsonObject { [FinanceKeys.ClosedMonths] = new JsonArray() });
            var firstAccount = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(first.Id, new FinanceAccountRequest("First current", "current", null, 0m, null, null, null, null, null)), Cancellation);
            var secondAccount = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(second.Id, new FinanceAccountRequest("Second current", "current", null, 0m, null, null, null, null, null)), Cancellation);
            Assert.True(firstAccount.IsSuccess);
            Assert.True(secondAccount.IsSuccess);
            var transaction = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(first.Id, new FinanceTransactionRequest("First transaction", new DateOnly(2026, 8, 3), -2m, firstAccount.Value.Id, null)), Cancellation);
            Assert.True(transaction.IsSuccess);
            await ForcePropertiesAsync(tree, ItemId.From(transaction.Value.Id), new JsonObject { [FinanceKeys.Account] = secondAccount.Value.Id.ToString("D") });
            var finance = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(first.Id), Cancellation);
            Assert.True(finance.IsSuccess);
            Assert.Equal(0, finance.Value.TransactionCount);
            Assert.Contains(finance.Value.Problems, problem => problem.Contains("account or line outside this finance root", StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task Generic_item_commands_cannot_bypass_reserved_finance_properties_or_closed_months()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")), Cancellation);
            Assert.True(configured.IsSuccess, configured.IsSuccess ? "" : configured.Error.Message);
            var account = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("Current", "current", null, 0m, null, null, null, null, null)), Cancellation);
            Assert.True(account.IsSuccess);
            var forgedCreate = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(root.WorkspaceId, "note", "Forged transaction", ItemId.From(configured.Value.Containers.Transactions), new JsonObject { [FinanceKeys.Kind] = FinanceKinds.Transaction }), Cancellation);
            Assert.True(forgedCreate.IsFailure);
            Assert.Equal("finance.reserved_property", forgedCreate.Error.Code);
            var transaction = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Rent", new DateOnly(2026, 8, 3), -100m, account.Value.Id, null)), Cancellation);
            Assert.True(transaction.IsSuccess);
            var september = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("September bill", new DateOnly(2026, 9, 3), -50m, account.Value.Id, null)), Cancellation);
            Assert.True(september.IsSuccess);
            var closed = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8), new FinanceMonthRequest(true)), Cancellation);
            Assert.True(closed.IsSuccess);

            var forged = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(transaction.Value.Id), new JsonObject { [FinanceKeys.Cleared] = (bool?)null }.ToJsonString()), Cancellation);
            Assert.True(forged.IsFailure);
            Assert.Equal("finance.reserved_property", forged.Error.Code);

            var renamed = await dispatcher.SendAsync<RenameItem, Item>(
                new RenameItem(ItemId.From(transaction.Value.Id), "Changed"), Cancellation);
            Assert.True(renamed.IsFailure);
            Assert.Equal("finance.month_closed", renamed.Error.Code);
            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(ItemId.From(transaction.Value.Id)), Cancellation);
            Assert.True(deleted.IsFailure);
            Assert.Equal("finance.month_closed", deleted.Error.Code);
            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(ItemId.From(transaction.Value.Id), null, null), Cancellation);
            Assert.True(moved.IsFailure);
            Assert.Equal("finance.month_closed", moved.Error.Code);

            var openMonthDelete = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(openMonthDelete.IsSuccess);

            var closedSeptember = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 9), new FinanceMonthRequest(true)), Cancellation);
            Assert.True(closedSeptember.IsSuccess);
            var restoreClosed = await dispatcher.SendAsync<RestoreItem, Item>(new RestoreItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(restoreClosed.IsFailure);
            Assert.Equal("finance.month_closed", restoreClosed.Error.Code);
            var purgeClosed = await dispatcher.SendAsync<PurgeItem, ItemId>(new PurgeItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(purgeClosed.IsFailure);
            Assert.Equal("finance.month_closed", purgeClosed.Error.Code);

            var reopenedSeptember = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 9), new FinanceMonthRequest(false)), Cancellation);
            Assert.True(reopenedSeptember.IsSuccess);
            var restoredOpen = await dispatcher.SendAsync<RestoreItem, Item>(new RestoreItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(restoredOpen.IsSuccess);
            var deleteAgain = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(deleteAgain.IsSuccess);
            closedSeptember = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 9), new FinanceMonthRequest(true)), Cancellation);
            Assert.True(closedSeptember.IsSuccess);
            purgeClosed = await dispatcher.SendAsync<PurgeItem, ItemId>(new PurgeItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(purgeClosed.IsFailure);
            Assert.Equal("finance.month_closed", purgeClosed.Error.Code);
            reopenedSeptember = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 9), new FinanceMonthRequest(false)), Cancellation);
            Assert.True(reopenedSeptember.IsSuccess);
            var purgedOpen = await dispatcher.SendAsync<PurgeItem, ItemId>(new PurgeItem(ItemId.From(september.Value.Id)), Cancellation);
            Assert.True(purgedOpen.IsSuccess);

            var rootDelete = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(root.Id), Cancellation);
            Assert.True(rootDelete.IsFailure);
            Assert.Equal("finance.month_closed", rootDelete.Error.Code);

            var reopened = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(
                new SetFinanceMonth(root.Id, new Nix.Domain.Finance.YearMonth(2026, 8), new FinanceMonthRequest(false)), Cancellation);
            Assert.True(reopened.IsSuccess);
            var deletedAfterReopen = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(ItemId.From(transaction.Value.Id)), Cancellation);
            Assert.True(deletedAfterReopen.IsSuccess);
        }
    }

    [Fact]
    public async Task Finance_boundary_query_plan_uses_the_workspace_closure_range()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 2, 0m, 0m, "UTC")), Cancellation);
            Assert.True(configured.IsSuccess);
            var account = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(
                new CreateFinanceAccount(root.Id, new FinanceAccountRequest("Plan account", "current", null, 0m, null, null, null, null, null)), Cancellation);
            Assert.True(account.IsSuccess);
            var transaction = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(
                new CreateFinanceTransaction(root.Id, new FinanceTransactionRequest("Representative finance row", new DateOnly(2026, 8, 3), -12m, account.Value.Id, null)), Cancellation);
            Assert.True(transaction.IsSuccess);
            for (var index = 0; index < 500; index++)
            {
                var ordinary = await dispatcher.SendAsync<CreateItem, Item>(
                    new CreateItem(root.WorkspaceId, "note", $"Ordinary child {index}", ItemId.From(configured.Value.Containers.Transactions), null), Cancellation);
                Assert.True(ordinary.IsSuccess);
            }

            var database = work.Resolve<NixDbContext>();
            var connection = (NpgsqlConnection)database.Database.GetDbConnection();
            await using var command = new NpgsqlCommand("""
                EXPLAIN (ANALYZE, BUFFERS)
                SELECT i.*
                FROM item_closure AS edge
                JOIN item AS i
                  ON i.tenant_id = edge.tenant_id
                 AND i.workspace_id = edge.workspace_id
                 AND i.id = CASE
                     WHEN edge.descendant_id = @item_id THEN edge.ancestor_id
                     ELSE edge.descendant_id
                 END
                WHERE edge.tenant_id = @tenant_id
                  AND edge.workspace_id = @workspace_id
                  AND (edge.descendant_id = @item_id OR (TRUE AND edge.ancestor_id = @item_id))
                  AND (i.properties ? '$fin_currency' OR i.properties ? '$fin_kind')
                  AND i.template_id IS NULL
                  AND i.lifecycle_state <> 'provisioning'
                ORDER BY i.id
                LIMIT 21001
                """, connection, (NpgsqlTransaction?)database.Database.CurrentTransaction?.GetDbTransaction());
            command.Parameters.Add(new NpgsqlParameter("item_id", NpgsqlDbType.Uuid) { Value = ItemId.From(configured.Value.Containers.Transactions).Value });
            command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = TestTenants.AlphaContext.TenantId.Value });
            command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = root.WorkspaceId.Value });
            await using var reader = await command.ExecuteReaderAsync(Cancellation);
            var plan = new List<string>();
            while (await reader.ReadAsync(Cancellation))
            {
                plan.Add(reader.GetString(0));
            }
            _output.WriteLine(string.Join(Environment.NewLine, plan));
            Assert.Contains(plan, line => line.Contains("item_closure", StringComparison.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public async Task Another_tenants_root_is_not_found()
    {
        Guid rootId;
        var alpha = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (alpha.ConfigureAwait(false))
        {
            var dispatcher = alpha.Resolve<NixDispatcher>();
            var root = await CreateRootAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(
                new SetFinanceSettings(root.Id, new FinanceSettingsRequest("GBP", "2026-08", 3, 0m, 0m, "UTC")), Cancellation);
            Assert.True(configured.IsSuccess);
            rootId = root.Id.Value;
            await alpha.CommitAsync(Cancellation);
        }
        var beta = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (beta.ConfigureAwait(false))
        {
            var read = await beta.Resolve<NixDispatcher>().QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(ItemId.From(rootId)), Cancellation);
            Assert.True(read.IsFailure);
            Assert.Equal("items.not_found", read.Error.Code);
        }
    }

    private static async Task<Item> CreateRootAsync(NixDispatcher dispatcher)
    {
        var created = await dispatcher.SendAsync<CreateItem, Item>(new CreateItem(Workspace, "note", "Finances", null, null), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }

    private static async Task<BudgetLineResponse> CreateLineAsync(NixDispatcher dispatcher, ItemId root, BudgetLineRequest request)
    {
        var created = await dispatcher.SendAsync<CreateBudgetLine, BudgetLineResponse>(new CreateBudgetLine(root, request), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }

    private static async Task ForcePropertiesAsync(IItemTree tree, ItemId id, JsonObject changes)
    {
        var item = await tree.FindStoredAsync(id, Cancellation);
        Assert.NotNull(item);
        var bag = item!.Properties is { } json
            ? JsonNode.Parse(json)?.AsObject() ?? new JsonObject()
            : new JsonObject();
        foreach (var change in changes)
        {
            bag[change.Key] = change.Value?.DeepClone();
        }
        // Deliberately operate below the feature boundary: these fixtures exercise loader handling
        // of legacy/corrupt durable JSON now that public generic commands must refuse such writes.
        await tree.UpdatePropertiesAsync(
            id,
            bag.ToJsonString(),
            TestTenants.AlphaContext.PrincipalId,
            DateTimeOffset.UtcNow,
            Cancellation);
    }

    private static async Task ForceRemovePropertyAsync(IItemTree tree, ItemId id, string key)
    {
        var item = await tree.FindStoredAsync(id, Cancellation);
        Assert.NotNull(item);
        var bag = item!.Properties is { } json
            ? JsonNode.Parse(json)?.AsObject() ?? new JsonObject()
            : new JsonObject();
        bag.Remove(key);
        await tree.UpdatePropertiesAsync(
            id,
            bag.ToJsonString(),
            TestTenants.AlphaContext.PrincipalId,
            DateTimeOffset.UtcNow,
            Cancellation);
    }
}
