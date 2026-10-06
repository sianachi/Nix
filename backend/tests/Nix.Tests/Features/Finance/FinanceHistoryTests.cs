using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Features.Finance;

namespace Nix.Tests.Features.Finance;

public sealed class FinanceHistoryTests
{
    private static readonly Guid Account = Guid.NewGuid();
    private static readonly Guid Line = Guid.NewGuid();
    private static ListFinanceTransactions Query => new(ItemId.From(Guid.NewGuid()), null, null, null, false, 2);

    [Fact]
    public void History_filters_before_pagination_and_totals_include_every_matching_record()
    {
        FinanceTransaction[] records = [
            Transaction("Old shop", new DateOnly(2025, 1, 1), -25),
            Transaction("Shop first", new DateOnly(2026, 1, 1), -25),
            Transaction("Shop second", new DateOnly(2026, 2, 1), -35),
            Transaction("Shop refund", new DateOnly(2026, 3, 1), 15),
            Transaction("Salary", new DateOnly(2026, 3, 1), 3000),
            Transaction("Shop imported", new DateOnly(2026, 3, 1), -20, FinanceSources.Import),
        ];
        var query = Query with { From = new DateOnly(2026, 1, 1), To = new DateOnly(2026, 3, 1), Search = "SHOP", Source = FinanceSources.Manual, MinAmount = 15, MaxAmount = 35 };
        Assert.Null(FinanceReportHandler.ValidateTransactionFilters(query));
        var first = FinanceReportHandler.FilterTransactions(records, query);
        Assert.Equal(3, first.Total);
        Assert.Equal(15, first.Inflow);
        Assert.Equal(60, first.Outflow);
        Assert.Equal(-45, first.Net);
        Assert.Equal(2, first.NextOffset);
        Assert.True(first.Truncated);
        Assert.Equal("Shop refund", first.Transactions[0].Description);
        var second = FinanceReportHandler.FilterTransactions(records, query with { Offset = 2 });
        Assert.Single(second.Transactions);
        Assert.Equal("Shop first", second.Transactions[0].Description);
        Assert.Equal(first.Net, second.Net);
        Assert.Null(second.NextOffset);
        Assert.False(second.Truncated);
    }

    [Fact]
    public void Exact_record_filter_finds_old_records_without_a_month_filter()
    {
        var old = Transaction("Old expense", new DateOnly(2025, 1, 1), -10);
        FinanceTransaction[] records = [old, Transaction("Recent expense", new DateOnly(2026, 1, 1), -20)];
        var result = FinanceReportHandler.FilterTransactions(records, Query with { TransactionId = old.Id });
        Assert.Equal(old.Id, Assert.Single(result.Transactions).Id);
        Assert.Equal(1, result.Total);
        Assert.Equal(-10, result.Net);
    }

    [Fact]
    public void Stable_order_does_not_repeat_tied_records_across_pages()
    {
        FinanceTransaction[] records = [
            Transaction("Same", new DateOnly(2026, 1, 1), -10) with { Id = Guid.Parse("11111111-1111-4111-8111-111111111111") },
            Transaction("Same", new DateOnly(2026, 1, 1), -10) with { Id = Guid.Parse("22222222-2222-4222-8222-222222222222") },
        ];
        var first = FinanceReportHandler.FilterTransactions(records.Reverse().ToArray(), Query with { Limit = 1 });
        var second = FinanceReportHandler.FilterTransactions(records, Query with { Limit = 1, Offset = 1 });
        Assert.NotEqual(first.Transactions[0].Id, second.Transactions[0].Id);
    }

    [Fact]
    public void History_rejects_unordered_dates_invalid_sources_and_unbounded_amounts_or_offsets()
    {
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { From = new DateOnly(2026, 2, 1), To = new DateOnly(2026, 1, 1) }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { Source = "other" }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { MinAmount = -1 }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { MinAmount = 10, MaxAmount = 1 }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { MaxAmount = 0.001m }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { Offset = -1 }));
        Assert.NotNull(FinanceReportHandler.ValidateTransactionFilters(Query with { Offset = 20_001 }));
    }

    private static FinanceTransaction Transaction(string description, DateOnly date, decimal amount, string source = FinanceSources.Manual) =>
        new(Guid.NewGuid(), description, date, amount, Account, Line, source, null, null, false);
}
