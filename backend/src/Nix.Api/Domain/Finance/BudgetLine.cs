using System.Text.Json.Nodes;

namespace Nix.Domain.Finance;

/// <summary>One line of the plan: a named amount of income or spending, every month, from one account.</summary>
/// <param name="Id">The line's item.</param>
/// <param name="Name">The item's title, such as Rent or Groceries.</param>
/// <param name="Section">The heading it is grouped under, such as Housing.</param>
/// <param name="Flow">Whether it brings money in or sends it out.</param>
/// <param name="AccountId">The account it is paid into or from.</param>
/// <param name="Amount">The planned amount in a month with no override.</param>
/// <param name="Overrides">Planned amounts for particular months, when they differ.</param>
/// <param name="Scheduled">
/// Whether the amount leaves on its own, as a direct debit or subscription does, so the module
/// may post it as a transaction; a variable line such as Groceries is only ever recorded by hand.
/// </param>
/// <param name="DueDay">For a scheduled line: the day of the month it goes out, clamped to the month.</param>
/// <param name="LoanAccount">When set, the plan is that loan's instalment rather than <paramref name="Amount"/>.</param>
/// <param name="Archived">Kept for history, planned no further.</param>
/// <param name="Position">Sibling order, which is the order lines are shown in.</param>
public sealed record BudgetLine(
    Guid Id,
    string Name,
    string Section,
    string Flow,
    Guid AccountId,
    decimal Amount,
    IReadOnlyDictionary<YearMonth, decimal> Overrides,
    bool Scheduled,
    int? DueDay,
    Guid? LoanAccount,
    bool Archived,
    long Position)
{
    public const int MaximumNameLength = 120;
    public const int MaximumSectionLength = 60;
    public const int MaximumOverrides = 240;

    public bool IsIncome => Flow == FinanceFlows.Income;

    /// <summary>The planned amount for a month.</summary>
    public decimal PlanFor(YearMonth month, IReadOnlyDictionary<Guid, FinanceAccount> accounts)
    {
        ArgumentNullException.ThrowIfNull(accounts);
        if (LoanAccount is { } loanId && accounts.TryGetValue(loanId, out var loan) && loan.IsLoan)
        {
            return loan.LoanInstalment;
        }
        return Overrides.TryGetValue(month, out var overridden) ? overridden : Amount;
    }

    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Name) || Name.Length > MaximumNameLength)
        {
            return $"A budget line needs a name of at most {MaximumNameLength} characters.";
        }
        if (string.IsNullOrWhiteSpace(Section) || Section.Length > MaximumSectionLength)
        {
            return $"A budget line needs a section of at most {MaximumSectionLength} characters.";
        }
        if (!FinanceFlows.IsValid(Flow))
        {
            return "Flow must be income or expense.";
        }
        if (!MoneyRules.IsAmount(Amount) || Amount < 0)
        {
            return "The planned amount must be zero or more, with at most two decimal places.";
        }
        if (Overrides.Count > MaximumOverrides || Overrides.Values.Any(amount => !MoneyRules.IsAmount(amount) || amount < 0))
        {
            return $"Month overrides must be amounts of zero or more, for at most {MaximumOverrides} months.";
        }
        if (DueDay is { } day && day is < 1 or > 31)
        {
            return "The due day must be between 1 and 31.";
        }
        if (Scheduled && DueDay is null)
        {
            return "A scheduled line needs the day of the month it goes out.";
        }
        if (LoanAccount is not null && IsIncome)
        {
            return "A loan repayment line is an expense.";
        }
        return null;
    }

    public JsonObject ToProperties() => new()
    {
        [FinanceKeys.Kind] = FinanceKinds.Line,
        [FinanceKeys.Section] = Section,
        [FinanceKeys.Flow] = Flow,
        [FinanceKeys.Account] = AccountId.ToString("D"),
        [FinanceKeys.Amount] = Amount,
        [FinanceKeys.Overrides] = FinanceJson.WriteMonthAmounts(Overrides),
        [FinanceKeys.Scheduled] = Scheduled,
        [FinanceKeys.DueDay] = DueDay,
        [FinanceKeys.LoanAccount] = LoanAccount?.ToString("D"),
        [FinanceKeys.Archived] = Archived,
    };

    /// <summary>The line an item describes, or null when it is not one or is malformed.</summary>
    public static BudgetLine? Read(Guid id, string name, long position, string? json)
    {
        var bag = FinanceJson.Bag(json);
        if (FinanceJson.Text(bag, FinanceKeys.Kind) != FinanceKinds.Line)
        {
            return null;
        }
        if (FinanceJson.Text(bag, FinanceKeys.Section) is not { } section
            || FinanceJson.Text(bag, FinanceKeys.Flow) is not { } flow
            || FinanceJson.Id(bag, FinanceKeys.Account) is not { } account
            || FinanceJson.Amount(bag, FinanceKeys.Amount) is not { } amount
            || FinanceJson.MonthAmounts(bag, FinanceKeys.Overrides) is not { } overrides
            || (FinanceJson.Has(bag, FinanceKeys.DueDay) && FinanceJson.Whole(bag, FinanceKeys.DueDay) is null)
            || (FinanceJson.Has(bag, FinanceKeys.LoanAccount) && FinanceJson.Id(bag, FinanceKeys.LoanAccount) is null))
        {
            return null;
        }
        var line = new BudgetLine(
            id,
            name,
            section,
            flow,
            account,
            amount,
            overrides,
            FinanceJson.Bool(bag, FinanceKeys.Scheduled) ?? false,
            FinanceJson.Whole(bag, FinanceKeys.DueDay),
            FinanceJson.Id(bag, FinanceKeys.LoanAccount),
            FinanceJson.Bool(bag, FinanceKeys.Archived) ?? false,
            position);
        return line.Validate() is null ? line : null;
    }

    public static bool Claims(string? json) => FinanceJson.Text(FinanceJson.Bag(json), FinanceKeys.Kind) == FinanceKinds.Line;
}
