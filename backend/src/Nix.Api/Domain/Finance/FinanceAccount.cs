using System.Text.Json.Nodes;

namespace Nix.Domain.Finance;

/// <summary>An account: somewhere money sits, is spent from, or is owed to.</summary>
/// <param name="Id">The account's item.</param>
/// <param name="Name">The item's title.</param>
/// <param name="Type">One of <see cref="FinanceAccountTypes"/>.</param>
/// <param name="Limit">A credit limit, when the account has one; drives utilisation.</param>
/// <param name="OpeningBalance">
/// For a card: the statement balance carried into the start month, collected in that month. For
/// a loan: the balance owed the day before the start month. For cash accounts: informational.
/// </param>
/// <param name="SettlesFrom">For a card: the account its statement is paid from.</param>
/// <param name="Apr">For a loan: the annual rate as a fraction, 0.11 for eleven percent.</param>
/// <param name="Payment">For a loan: the standard monthly payment.</param>
/// <param name="Overpayment">For a loan: the extra paid every month on top.</param>
/// <param name="Target">For a savings account: the balance being saved towards.</param>
/// <param name="Archived">Kept for history, offered nowhere new.</param>
public sealed record FinanceAccount(
    Guid Id,
    string Name,
    string Type,
    decimal? Limit,
    decimal OpeningBalance,
    Guid? SettlesFrom,
    decimal? Apr,
    decimal? Payment,
    decimal? Overpayment,
    decimal? Target,
    bool Archived)
{
    public const int MaximumNameLength = 120;

    public bool IsCreditCard => Type == FinanceAccountTypes.CreditCard;
    public bool IsLoan => Type == FinanceAccountTypes.Loan;

    /// <summary>What leaves the settlement account each month for a loan: payment plus overpayment.</summary>
    public decimal LoanInstalment => (Payment ?? 0) + (Overpayment ?? 0);

    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Name) || Name.Length > MaximumNameLength)
        {
            return $"An account needs a name of at most {MaximumNameLength} characters.";
        }
        if (!FinanceAccountTypes.IsValid(Type))
        {
            return "Account type must be current, savings, debit, credit_card or loan.";
        }
        if (!MoneyRules.IsAmount(OpeningBalance) || (Type is not FinanceAccountTypes.Current && OpeningBalance < 0))
        {
            return "Opening balance must be an amount with at most two decimal places, and not negative for cards and loans.";
        }
        if (Limit is { } limit && (!MoneyRules.IsAmount(limit) || limit <= 0))
        {
            return "A credit limit must be a positive amount.";
        }
        if (!IsCreditCard && Limit is not null)
        {
            return "Only a credit card has a credit limit.";
        }
        if (Target is { } target && (!MoneyRules.IsAmount(target) || target <= 0))
        {
            return "A savings target must be a positive amount.";
        }
        if (Target is not null && Type != FinanceAccountTypes.Savings)
        {
            return "Only a savings account has a savings target.";
        }
        if (IsCreditCard && SettlesFrom is null)
        {
            return "A credit card needs the account its statement is paid from.";
        }
        if (!IsCreditCard && SettlesFrom is not null)
        {
            return "Only a credit card names a statement settlement account.";
        }
        if (SettlesFrom == Id)
        {
            return "An account cannot settle from itself.";
        }
        if (IsLoan)
        {
            if (Apr is not { } apr || apr < 0 || apr > 2 || decimal.Round(apr, 6) != apr)
            {
                return "A loan needs an annual rate between 0 and 2, as a fraction such as 0.11.";
            }
            if (Payment is not { } payment || !MoneyRules.IsAmount(payment) || payment <= 0)
            {
                return "A loan needs a positive standard monthly payment.";
            }
            if (Overpayment is { } over && (!MoneyRules.IsAmount(over) || over < 0))
            {
                return "A loan overpayment cannot be negative.";
            }
        }
        else if (Apr is not null || Payment is not null || Overpayment is not null)
        {
            return "Only a loan has a rate, a payment and an overpayment.";
        }
        return null;
    }

    public JsonObject ToProperties() => new()
    {
        [FinanceKeys.Kind] = FinanceKinds.Account,
        [FinanceKeys.AccountType] = Type,
        [FinanceKeys.Limit] = Limit,
        [FinanceKeys.OpeningBalance] = OpeningBalance,
        [FinanceKeys.SettlesFrom] = SettlesFrom?.ToString("D"),
        [FinanceKeys.Apr] = Apr,
        [FinanceKeys.Payment] = Payment,
        [FinanceKeys.Overpayment] = Overpayment,
        [FinanceKeys.Target] = Target,
        [FinanceKeys.Archived] = Archived,
    };

    /// <summary>The account an item describes, or null when it is not one or is malformed.</summary>
    public static FinanceAccount? Read(Guid id, string name, string? json)
    {
        var bag = FinanceJson.Bag(json);
        if (FinanceJson.Text(bag, FinanceKeys.Kind) != FinanceKinds.Account)
        {
            return null;
        }
        if (FinanceJson.Text(bag, FinanceKeys.AccountType) is not { } type
            || FinanceJson.Amount(bag, FinanceKeys.OpeningBalance) is not { } opening
            || (FinanceJson.Has(bag, FinanceKeys.Limit) && FinanceJson.Amount(bag, FinanceKeys.Limit) is null)
            || (FinanceJson.Has(bag, FinanceKeys.SettlesFrom) && FinanceJson.Id(bag, FinanceKeys.SettlesFrom) is null)
            || (FinanceJson.Has(bag, FinanceKeys.Apr) && FinanceJson.Amount(bag, FinanceKeys.Apr) is null)
            || (FinanceJson.Has(bag, FinanceKeys.Payment) && FinanceJson.Amount(bag, FinanceKeys.Payment) is null)
            || (FinanceJson.Has(bag, FinanceKeys.Overpayment) && FinanceJson.Amount(bag, FinanceKeys.Overpayment) is null)
            || (FinanceJson.Has(bag, FinanceKeys.Target) && FinanceJson.Amount(bag, FinanceKeys.Target) is null))
        {
            return null;
        }
        var account = new FinanceAccount(
            id,
            name,
            type,
            FinanceJson.Amount(bag, FinanceKeys.Limit),
            opening,
            FinanceJson.Id(bag, FinanceKeys.SettlesFrom),
            FinanceJson.Amount(bag, FinanceKeys.Apr),
            FinanceJson.Amount(bag, FinanceKeys.Payment),
            FinanceJson.Amount(bag, FinanceKeys.Overpayment),
            FinanceJson.Amount(bag, FinanceKeys.Target),
            FinanceJson.Bool(bag, FinanceKeys.Archived) ?? false);
        return account.Validate() is null ? account : null;
    }

    /// <summary>Whether an item claims to be an account, whether or not it reads cleanly.</summary>
    public static bool Claims(string? json) => FinanceJson.Text(FinanceJson.Bag(json), FinanceKeys.Kind) == FinanceKinds.Account;
}
