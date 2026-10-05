using Nix.Domain.Finance;

namespace Nix.Tests.Domain.Finance;

/// <summary>Synthetic ledger with deliberately simple amounts for independent arithmetic checks.</summary>
public sealed class FinanceBookTests
{
    private static readonly YearMonth Aug = new(2026, 8);
    private static readonly YearMonth Sep = new(2026, 9);
    private static readonly Guid CurrentAccount = Guid.NewGuid();
    private static readonly Guid PrimaryCard = Guid.NewGuid();
    private static readonly Guid SecondCard = Guid.NewGuid();
    private static readonly Guid DebitAccount = Guid.NewGuid();
    private static readonly Guid Loan = Guid.NewGuid();
    private static readonly Guid Salary = Guid.NewGuid();
    private static readonly Guid Groceries = Guid.NewGuid();
    private static readonly Guid LoanLine = Guid.NewGuid();

    private static FinanceSettings Settings => new("GBP", Aug, 17, 2000m, 3m, "Europe/London");

    private static List<FinanceAccount> Accounts =>
    [
        new(CurrentAccount, "Example current account", FinanceAccountTypes.Current, null, 2000m, null, null, null, null, null, false),
        new(PrimaryCard, "PrimaryCard", FinanceAccountTypes.CreditCard, 3000m, 100m, CurrentAccount, null, null, null, null, false),
        new(SecondCard, "Example card B", FinanceAccountTypes.CreditCard, null, 0m, CurrentAccount, null, null, null, null, false),
        new(DebitAccount, "Example debit", FinanceAccountTypes.Debit, null, 0m, null, null, null, null, null, false),
        new(Loan, "Loan", FinanceAccountTypes.Loan, null, 6000m, null, 0.06m, 300m, 0m, null, false),
    ];

    private static readonly Dictionary<YearMonth, decimal> NoOverrides = [];

    private static List<BudgetLine> Lines
    {
        get
        {
            var position = 0;
            BudgetLine Line(Guid id, string name, string section, string flow, Guid account, decimal amount, bool scheduled = true, Guid? loan = null, Dictionary<YearMonth, decimal>? overrides = null) =>
                new(id, name, section, flow, account, amount, overrides ?? NoOverrides, scheduled, scheduled ? 1 : null, loan, false, position++);
            return
            [
                Line(Salary, "Example earnings", "Income", FinanceFlows.Income, CurrentAccount, 4000m, overrides: new() { [new YearMonth(2027, 4)] = 4500m }),
                Line(Guid.NewGuid(), "Rent", "Housing", FinanceFlows.Expense, CurrentAccount, 900m),
                Line(Guid.NewGuid(), "Utilities", "Housing", FinanceFlows.Expense, CurrentAccount, 100m),
                Line(LoanLine, "Loan repayment", "Commitments", FinanceFlows.Expense, CurrentAccount, 0m, loan: Loan),
                Line(Guid.NewGuid(), "Example membership", "Commitments", FinanceFlows.Expense, CurrentAccount, 100m),
                Line(Guid.NewGuid(), "Example mobile plan", "Phone", FinanceFlows.Expense, CurrentAccount, 50m),
                Line(Guid.NewGuid(), "Example subscription", "Example card B", FinanceFlows.Expense, SecondCard, 100m),
                Line(Groceries, "Groceries", "PrimaryCard", FinanceFlows.Expense, PrimaryCard, 200m, scheduled: false),
                Line(Guid.NewGuid(), "Travel", "PrimaryCard", FinanceFlows.Expense, PrimaryCard, 100m, scheduled: false),
                Line(Guid.NewGuid(), "Example debit spending", "Example debit", FinanceFlows.Expense, DebitAccount, 50m, scheduled: false),
            ];
        }
    }

    private static FinanceBook Book(IEnumerable<FinanceTransaction>? transactions = null, IEnumerable<YearMonth>? closed = null) =>
        new(Settings, Accounts, Lines, transactions?.ToList() ?? [], closed ?? []);

    [Fact]
    public void The_plan_sums_the_synthetic_income_and_expenses()
    {
        var figures = Book().Figures(Aug, FigureSource.Plan);

        Assert.Equal(4000m, figures.Income);
        Assert.Equal(1500m, figures.PaidThisMonth);
        Assert.Equal(400m, figures.CardSpend);
        Assert.Equal(1900m, figures.Outgoings);
        Assert.Equal(2100m, figures.Net);
    }

    [Fact]
    public void A_loan_line_plans_the_loan_instalment_and_an_override_changes_one_month()
    {
        var book = Book();
        var loanLine = book.LinesById[LoanLine];
        var salary = book.LinesById[Salary];

        Assert.Equal(300m, book.Plan(loanLine, Aug));
        Assert.Equal(4000m, book.Plan(salary, Aug));
        Assert.Equal(4500m, book.Plan(salary, new YearMonth(2027, 4)));
        Assert.Equal(4000m, book.Plan(salary, new YearMonth(2027, 5)));
    }

    [Fact]
    public void Actuals_come_from_transactions_and_read_as_positive_amounts_of_the_lines_flow()
    {
        var book = Book(
        [
            Transaction(new DateOnly(2026, 8, 3), -59m, PrimaryCard, Groceries),
            Transaction(new DateOnly(2026, 8, 12), -35m, PrimaryCard, Groceries),
            Transaction(new DateOnly(2026, 8, 20), 10m, PrimaryCard, Groceries),
            Transaction(new DateOnly(2026, 8, 25), 4000m, CurrentAccount, Salary),
            Transaction(new DateOnly(2026, 8, 26), -12.5m, PrimaryCard, null),
            Transaction(new DateOnly(2026, 9, 2), -40m, PrimaryCard, Groceries),
        ]);
        var groceries = book.LinesById[Groceries];

        Assert.Equal(84m, book.Actual(groceries, Aug));
        Assert.Equal(3, book.TransactionCount(groceries, Aug));
        Assert.Equal(4000m, book.Actual(book.LinesById[Salary], Aug));
        Assert.Equal(12.5m, book.UnassignedOutflow(Aug));
        Assert.Equal(12.5m, book.UnassignedOutflow(PrimaryCard, Aug));
        Assert.Equal(40m, book.Actual(groceries, Sep));
        var actual = book.Figures(Aug, FigureSource.Actual);
        Assert.Equal(4000m, actual.Income);
        Assert.Equal(96.5m, actual.CardSpend);
        Assert.Equal(0m, actual.PaidThisMonth);
    }

    [Fact]
    public void An_unassigned_card_refund_reduces_card_owed_and_carries_forward_without_becoming_income()
    {
        var book = Book(
        [
            Transaction(new DateOnly(2026, 8, 25), 700m, PrimaryCard, null),
        ], [Aug]);
        var actual = book.Figures(Aug, FigureSource.Actual);
        var cycle = CardCycles.Compute(book, book.AccountsById[PrimaryCard], FigureSource.Auto, Aug, Sep);

        Assert.Equal(0m, actual.Income);
        Assert.Equal(-700m, actual.CardSpend);
        Assert.Equal(700m, book.UnassignedCardCredit(PrimaryCard, Aug));
        Assert.Equal(-700m, cycle.For(Aug)!.Closing);
        Assert.Equal(0m, cycle.For(Sep)!.PaymentOut);
        Assert.Equal(-400m, cycle.For(Sep)!.Closing);
    }

    [Fact]
    public void The_budget_grid_groups_lines_by_section_and_carries_the_running_net()
    {
        var grid = BudgetGrids.Compute(Book(), Aug, new YearMonth(2026, 10));

        Assert.Equal(3, grid.Months.Count);
        Assert.Equal(["Income", "Housing", "Commitments", "Phone", "Example card B", "PrimaryCard", "Example debit"], grid.Sections.Select(section => section.Name));
        var housing = grid.Sections.Single(section => section.Name == "Housing");
        Assert.Equal(1000m, housing.Totals[0].Plan);
        Assert.Equal(2100m, grid.Totals[0].CumulativeNetPlan);
        Assert.Equal(4200m, grid.Totals[1].CumulativeNetPlan);
        Assert.Equal(6300m, grid.Totals[2].CumulativeNetPlan);
        Assert.Equal(0m, grid.Totals[0].CumulativeNetActual);
    }

    [Fact]
    public void One_accounts_figures_count_only_its_lines_and_its_unassigned_money_and_add_up_to_the_months()
    {
        var book = Book(
        [
            Transaction(new DateOnly(2026, 8, 3), -59m, PrimaryCard, Groceries),
            Transaction(new DateOnly(2026, 8, 25), 4000m, CurrentAccount, Salary),
            Transaction(new DateOnly(2026, 8, 26), -12.5m, PrimaryCard, null),
            Transaction(new DateOnly(2026, 8, 27), -30m, CurrentAccount, null),
            Transaction(new DateOnly(2026, 8, 28), 15m, CurrentAccount, null),
        ]);

        var cardPlan = book.Figures(Aug, FigureSource.Plan, PrimaryCard);
        Assert.Equal(0m, cardPlan.Income);
        Assert.Equal(0m, cardPlan.PaidThisMonth);
        Assert.Equal(300m, cardPlan.CardSpend);

        var cardActual = book.Figures(Aug, FigureSource.Actual, PrimaryCard);
        Assert.Equal(0m, cardActual.Income);
        Assert.Equal(71.5m, cardActual.CardSpend);
        Assert.Equal(1, book.UnassignedCount(PrimaryCard, Aug));

        var currentActual = book.Figures(Aug, FigureSource.Actual, CurrentAccount);
        Assert.Equal(4015m, currentActual.Income);
        Assert.Equal(30m, currentActual.PaidThisMonth);
        Assert.Equal(0m, currentActual.CardSpend);
        Assert.Equal(15m, book.UnassignedInflow(CurrentAccount, Aug));
        Assert.Equal(2, book.UnassignedCount(CurrentAccount, Aug));

        var whole = book.Figures(Aug, FigureSource.Actual);
        var summed = Accounts.Select(account => book.Figures(Aug, FigureSource.Actual, account.Id)).ToList();
        Assert.Equal(whole.Income, summed.Sum(figures => figures.Income));
        Assert.Equal(whole.PaidThisMonth, summed.Sum(figures => figures.PaidThisMonth));
        Assert.Equal(whole.CardSpend, summed.Sum(figures => figures.CardSpend));
        Assert.Equal(3, book.UnassignedCount(Aug));
    }

    [Fact]
    public void The_budget_grid_narrowed_to_an_account_keeps_only_its_lines_and_totals_its_month_alone()
    {
        var book = Book(
        [
            Transaction(new DateOnly(2026, 8, 3), -59m, PrimaryCard, Groceries),
            Transaction(new DateOnly(2026, 8, 26), -12.5m, PrimaryCard, null),
            Transaction(new DateOnly(2026, 8, 27), -30m, CurrentAccount, null),
        ]);

        var grid = BudgetGrids.Compute(book, Aug, Sep, PrimaryCard);

        Assert.Equal(PrimaryCard, grid.AccountId);
        Assert.Equal(["PrimaryCard"], grid.Sections.Select(section => section.Name));
        Assert.Equal(["Groceries", "Travel"], grid.Sections[0].Lines.Select(row => row.Line.Name));
        Assert.Equal(300m, grid.Sections[0].Totals[0].Plan);
        Assert.Equal(59m, grid.Sections[0].Totals[0].Actual);
        Assert.Equal(300m, grid.Totals[0].Plan.CardSpend);
        Assert.Equal(71.5m, grid.Totals[0].Actual.CardSpend);
        Assert.Equal(0m, grid.Totals[0].Actual.PaidThisMonth);
        Assert.Equal(12.5m, grid.Totals[0].UnassignedOutflow);
        Assert.Equal(1, grid.Totals[0].UnassignedTransactions);
        Assert.Equal(-300m, grid.Totals[0].CumulativeNetPlan);
        Assert.Equal(-600m, grid.Totals[1].CumulativeNetPlan);
        Assert.Null(BudgetGrids.Compute(book, Aug, Sep).AccountId);
    }

    [Fact]
    public void The_card_cycle_collects_last_months_spend_and_the_carried_in_balance_first()
    {
        var book = Book();
        var cycle = CardCycles.Compute(book, book.AccountsById[PrimaryCard], FigureSource.Plan, Aug, new YearMonth(2026, 10));

        var august = cycle.For(Aug)!;
        Assert.Equal(100m, august.Opening);
        Assert.Equal(300m, august.Spend);
        Assert.Equal(100m, august.PaymentOut);
        Assert.Equal(300m, august.Closing);
        Assert.Equal(0.1m, august.Utilisation);
        var september = cycle.For(Sep)!;
        Assert.Equal(300m, september.Opening);
        Assert.Equal(300m, september.PaymentOut);
        Assert.Equal(300m, september.Closing);
    }

    [Fact]
    public void Cash_flow_tracks_card_arrears_and_the_budget_net()
    {
        var projection = CashFlowProjections.Compute(Book(), Aug);

        Assert.Equal(2000m, projection.OpeningBank);
        Assert.Equal(100m, projection.OpeningCardOwed);
        Assert.Equal(1900m, projection.OpeningNetPosition);
        Assert.Equal(17, projection.Months.Count);
        var august = projection.For(Aug)!;
        Assert.Equal(FigureSource.Plan, august.Source);
        Assert.Equal(100m, august.CardPaymentOut);
        Assert.Equal(2400m, august.CashNet);
        Assert.Equal(4400m, august.ClosingBank);
        Assert.Equal(400m, august.CardOwed);
        Assert.Equal(4000m, august.NetPosition);
        var september = projection.For(Sep)!;
        Assert.Equal(400m, september.CardPaymentOut);
        Assert.Equal(2100m, september.CashNet);
        Assert.Equal(6100m, september.NetPosition);
        Assert.Equal(3m * 1900m, projection.EmergencyTarget);
        Assert.Equal(3m * 1900m, august.EmergencyTarget);
        Assert.NotNull(projection.BufferMetIn);
        Assert.True(projection.For(projection.BufferMetIn!.Value)!.NetPosition >= projection.EmergencyTarget);
    }

    [Fact]
    public void Emergency_target_and_buffer_met_use_each_month_s_plan()
    {
        var april = new YearMonth(2027, 4);
        var december = new YearMonth(2027, 12);
        var lines = Lines;
        var rent = lines.Single(line => line.Name == "Rent");
        var rentOverrides = new Dictionary<YearMonth, decimal>(rent.Overrides);
        foreach (var month in YearMonth.Range(april, december))
        {
            rentOverrides[month] = 850m;
        }
        lines = lines.Select(line => line.Id == rent.Id ? line with { Overrides = rentOverrides } : line).ToList();

        var book = new FinanceBook(Settings, Accounts, lines, [], []);
        var initialAprilPosition = CashFlowProjections.Compute(book, Sep).For(april)!.NetPosition;
        var openingCash = Settings.OpeningCash + (5625m - initialAprilPosition);
        book = new FinanceBook(Settings with { OpeningCash = openingCash }, Accounts, lines, [], []);

        var projection = CashFlowProjections.Compute(book, Sep);
        var september = projection.For(Sep)!;
        var aprilPosition = projection.For(april)!;

        Assert.Equal(5700m, projection.EmergencyTarget);
        Assert.Equal(5700m, september.EmergencyTarget);
        Assert.Equal(5550m, aprilPosition.EmergencyTarget);
        Assert.Equal(5625m, aprilPosition.NetPosition);
        Assert.True(aprilPosition.BufferMet);
        Assert.Equal(april, projection.BufferMetIn!.Value);
        Assert.All(YearMonth.Range(april, december), month =>
            Assert.Equal(5550m, projection.For(month)!.EmergencyTarget));
    }

    [Fact]
    public void Closing_a_month_switches_it_to_its_transactions_and_rechains_every_later_month()
    {
        var book = Book(
        [
            Transaction(new DateOnly(2026, 8, 25), 4000m, CurrentAccount, Salary),
            Transaction(new DateOnly(2026, 8, 3), -350m, PrimaryCard, Groceries),
        ], [Aug]);
        var projection = CashFlowProjections.Compute(book, Aug);

        var august = projection.For(Aug)!;
        Assert.Equal(FigureSource.Actual, august.Source);
        Assert.Equal(4000m - 0m - 100m, august.CashNet);
        Assert.Equal(350m, august.CardOwed);
        var september = projection.For(Sep)!;
        Assert.Equal(FigureSource.Plan, september.Source);
        Assert.Equal(350m, september.CardPaymentOut);
        Assert.Equal(august.ClosingBank + 4000m - 1500m - 350m, september.ClosingBank);
    }

    [Fact]
    public void Archived_lines_plan_nothing_but_their_transactions_still_count()
    {
        var lines = Lines;
        var groceries = lines.Single(line => line.Id == Groceries) with { Archived = true };
        var book = new FinanceBook(Settings, Accounts, lines.Select(line => line.Id == Groceries ? groceries : line).ToList(),
            [Transaction(new DateOnly(2026, 8, 3), -20m, PrimaryCard, Groceries)], []);

        Assert.Equal(0m, book.Plan(groceries, Aug));
        Assert.Equal(20m, book.Actual(groceries, Aug));
    }

    private static FinanceTransaction Transaction(DateOnly date, decimal amount, Guid account, Guid? line) =>
        new(Guid.NewGuid(), "Test", date, amount, account, line, FinanceSources.Manual, null, null, false);
}
