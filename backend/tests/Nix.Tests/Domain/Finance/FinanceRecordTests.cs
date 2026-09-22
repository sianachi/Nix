using System.Text.Json.Nodes;
using Nix.Domain.Finance;

namespace Nix.Tests.Domain.Finance;

/// <summary>Records round-trip through the property bag, and refuse what a bag should never hold.</summary>
public sealed class FinanceRecordTests
{
    [Theory]
    [InlineData("2026-08", true, 2026, 8)]
    [InlineData("2026-13", false, 0, 0)]
    [InlineData("26-08", false, 0, 0)]
    [InlineData("2026/08", false, 0, 0)]
    [InlineData(null, false, 0, 0)]
    public void Months_parse_only_as_yyyy_MM(string? text, bool ok, int year, int month)
    {
        Assert.Equal(ok, YearMonth.TryParse(text, out var parsed));
        if (ok)
        {
            Assert.Equal(new YearMonth(year, month), parsed);
            Assert.Equal(text, parsed.ToString());
        }
    }

    [Fact]
    public void Month_arithmetic_crosses_years_and_clamps_days()
    {
        var december = new YearMonth(2026, 12);

        Assert.Equal(new YearMonth(2027, 1), december.AddMonths(1));
        Assert.Equal(new YearMonth(2025, 11), december.AddMonths(-13));
        Assert.Equal(new DateOnly(2027, 2, 28), new YearMonth(2027, 2).Day(31));
        Assert.Equal(17, YearMonth.Range(new YearMonth(2026, 8), new YearMonth(2027, 12)).Count());
        Assert.True(new YearMonth(2026, 8) < new YearMonth(2027, 1));
    }

    [Fact]
    public void Settings_round_trip_and_refuse_bad_values()
    {
        var settings = new FinanceSettings("GBP", new YearMonth(2026, 8), 17, 2000m, 3m, "Europe/London");

        Assert.Null(settings.Validate());
        Assert.Equal(new YearMonth(2027, 12), settings.EndMonth);
        var read = FinanceSettings.Read(settings.ToProperties().ToJsonString());
        Assert.Equal(settings, read);
        Assert.NotNull((settings with { Currency = "pounds" }).Validate());
        Assert.NotNull((settings with { HorizonMonths = 0 }).Validate());
        Assert.NotNull((settings with { OpeningCash = 1.234m }).Validate());
        Assert.NotNull((settings with { Timezone = "Mars/Olympus" }).Validate());
        Assert.Null(FinanceSettings.Read("{}"));
        Assert.Null(FinanceSettings.Read("not json"));
    }

    [Fact]
    public void Accounts_round_trip_and_each_type_demands_its_own_fields()
    {
        var current = Guid.NewGuid();
        var card = new FinanceAccount(Guid.NewGuid(), "PrimaryCard", FinanceAccountTypes.CreditCard, 3000m, 100m, current, null, null, null, null, false);
        var loan = new FinanceAccount(Guid.NewGuid(), "Loan", FinanceAccountTypes.Loan, null, 6000m, null, 0.06m, 300m, 0m, null, false);

        Assert.Null(card.Validate());
        Assert.Null(loan.Validate());
        Assert.Equal(card, FinanceAccount.Read(card.Id, card.Name, card.ToProperties().ToJsonString()));
        Assert.Equal(loan, FinanceAccount.Read(loan.Id, loan.Name, loan.ToProperties().ToJsonString()));
        Assert.NotNull((card with { SettlesFrom = null }).Validate());
        Assert.NotNull((card with { Apr = 0.2m }).Validate());
        Assert.NotNull((loan with { Payment = null }).Validate());
        Assert.NotNull((loan with { Apr = 5m }).Validate());
        Assert.NotNull((card with { OpeningBalance = -1m }).Validate());
        Assert.Null(FinanceAccount.Read(Guid.NewGuid(), "x", """{"$fin_kind":"account","$fin_account_type":"credit_card"}"""));
        Assert.True(FinanceAccount.Claims("""{"$fin_kind":"account"}"""));
        Assert.False(FinanceAccount.Claims("""{"$fin_kind":"line"}"""));
    }

    [Fact]
    public void Lines_round_trip_with_their_overrides()
    {
        var line = new BudgetLine(Guid.NewGuid(), "Salary", "Income", FinanceFlows.Income, Guid.NewGuid(), 4000m, new Dictionary<YearMonth, decimal> { [new YearMonth(2027, 4)] = 4500m }, true, 25, null, false, 3);

        Assert.Null(line.Validate());
        var read = BudgetLine.Read(line.Id, line.Name, 3, line.ToProperties().ToJsonString());
        Assert.NotNull(read);
        Assert.Equal(4500m, read.Overrides[new YearMonth(2027, 4)]);
        Assert.Equal(line with { Overrides = read.Overrides }, read);
        Assert.NotNull((line with { Flow = "sideways" }).Validate());
        Assert.NotNull((line with { Scheduled = true, DueDay = null }).Validate());
        Assert.NotNull((line with { Amount = -1m }).Validate());
        var bag = line.ToProperties();
        bag[FinanceKeys.Overrides] = new JsonObject { ["2027-4"] = 1m };
        Assert.Null(BudgetLine.Read(line.Id, line.Name, 3, bag.ToJsonString()));
    }

    [Fact]
    public void Transactions_round_trip_and_a_posted_one_names_its_month_and_line()
    {
        var manual = new FinanceTransaction(Guid.NewGuid(), "Example shop", new DateOnly(2026, 9, 21), -12.4m, Guid.NewGuid(), Guid.NewGuid(), FinanceSources.Manual, null, null, false);
        var posted = manual with { Source = FinanceSources.Scheduled, PostedFor = new YearMonth(2026, 9) };

        Assert.Null(manual.Validate());
        Assert.Null(posted.Validate());
        Assert.Equal(manual, FinanceTransaction.Read(manual.Id, manual.Description, manual.ToProperties().ToJsonString()));
        Assert.Equal(posted, FinanceTransaction.Read(posted.Id, posted.Description, posted.ToProperties().ToJsonString()));
        Assert.NotNull((manual with { Amount = 0m }).Validate());
        Assert.NotNull((manual with { Amount = 1.005m }).Validate());
        Assert.NotNull((manual with { PostedFor = new YearMonth(2026, 9) }).Validate());
        Assert.NotNull((posted with { LineId = null }).Validate());
        Assert.NotNull((posted with { Date = new DateOnly(2026, 10, 1) }).Validate());
        Assert.Equal(new YearMonth(2026, 9), manual.Month);
    }

    [Fact]
    public void Money_is_two_places_below_a_billion()
    {
        Assert.True(MoneyRules.IsAmount(12.40m));
        Assert.True(MoneyRules.IsAmount(-999_999_999.99m));
        Assert.False(MoneyRules.IsAmount(12.401m));
        Assert.False(MoneyRules.IsAmount(1_000_000_000m));
        Assert.False(MoneyRules.IsAmount(decimal.MinValue));
        Assert.Equal(0.13m, MoneyRules.Round(0.125m));
        Assert.Equal(-0.13m, MoneyRules.Round(-0.125m));
    }

    [Fact]
    public void Closed_months_distinguish_an_unset_field_from_a_broken_value()
    {
        Assert.Empty(FinanceJson.Months(new JsonObject(), FinanceKeys.ClosedMonths)!);
        Assert.Null(FinanceJson.Months(new JsonObject { [FinanceKeys.ClosedMonths] = null }, FinanceKeys.ClosedMonths));
    }
}
