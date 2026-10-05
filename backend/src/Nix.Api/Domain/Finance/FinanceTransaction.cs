using System.Text.Json.Nodes;

namespace Nix.Domain.Finance;

/// <summary>Money that moved: one transaction on one account, on one day.</summary>
/// <param name="Id">The transaction's item.</param>
/// <param name="Description">The item's title: the payee or what it was for.</param>
/// <param name="Date">The day it happened; it belongs to that day's month.</param>
/// <param name="Amount">
/// The cash effect on the account: negative when money left, positive when it arrived. A refund
/// on a spending line is therefore positive and reduces that line's total.
/// </param>
/// <param name="AccountId">The account it moved on.</param>
/// <param name="LineId">The budget line it counts against, or null while unassigned.</param>
/// <param name="Source">How it was recorded: by hand, posted from the plan, or imported.</param>
/// <param name="PostedFor">For a posted line: the month whose plan it stands for.</param>
/// <param name="ImportKey">For an imported row: the digest that stops it arriving twice.</param>
/// <param name="Cleared">Whether it has been seen on a statement.</param>
public sealed record FinanceTransaction(
    Guid Id,
    string Description,
    DateOnly Date,
    decimal Amount,
    Guid AccountId,
    Guid? LineId,
    string Source,
    YearMonth? PostedFor,
    string? ImportKey,
    bool Cleared)
{
    public const int MaximumDescriptionLength = 200;
    public const int MaximumImportKeyLength = 64;

    public YearMonth Month => YearMonth.Of(Date);

    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Description) || Description.Length > MaximumDescriptionLength)
        {
            return $"A transaction needs a description of at most {MaximumDescriptionLength} characters.";
        }
        if (!MoneyRules.IsAmount(Amount) || Amount == 0)
        {
            return "The amount must be non-zero, with at most two decimal places.";
        }
        if (Date.Year is < 1970 or > 2200)
        {
            return "The date must be between 1970 and 2200.";
        }
        if (!FinanceSources.IsValid(Source))
        {
            return "Source must be manual, scheduled or import.";
        }
        if ((Source == FinanceSources.Scheduled) != (PostedFor is not null))
        {
            return "A posted transaction names the month it was posted for, and only a posted one does.";
        }
        if (PostedFor is not null && LineId is null)
        {
            return "A posted transaction names its budget line.";
        }
        if (PostedFor is { } postedFor && postedFor != Month)
        {
            return "A posted transaction's date must fall in the month it was posted for.";
        }
        if (ImportKey is { } key && (key.Length == 0 || key.Length > MaximumImportKeyLength))
        {
            return $"An import key is at most {MaximumImportKeyLength} characters.";
        }
        return null;
    }

    public JsonObject ToProperties() => new()
    {
        [FinanceKeys.Kind] = FinanceKinds.Transaction,
        [FinanceKeys.Date] = FinanceJson.DateText(Date),
        [FinanceKeys.Amount] = Amount,
        [FinanceKeys.Account] = AccountId.ToString("D"),
        [FinanceKeys.Line] = LineId?.ToString("D"),
        [FinanceKeys.Source] = Source,
        [FinanceKeys.PostedFor] = PostedFor?.ToString(),
        [FinanceKeys.ImportKey] = ImportKey,
        [FinanceKeys.Cleared] = Cleared,
    };

    /// <summary>The transaction an item describes, or null when it is not one or is malformed.</summary>
    public static FinanceTransaction? Read(Guid id, string description, string? json)
    {
        var bag = FinanceJson.Bag(json);
        if (FinanceJson.Text(bag, FinanceKeys.Kind) != FinanceKinds.Transaction)
        {
            return null;
        }
        if (FinanceJson.Date(bag, FinanceKeys.Date) is not { } date
            || FinanceJson.Amount(bag, FinanceKeys.Amount) is not { } amount
            || FinanceJson.Id(bag, FinanceKeys.Account) is not { } account
            || (FinanceJson.Has(bag, FinanceKeys.Line) && FinanceJson.Id(bag, FinanceKeys.Line) is null)
            || (FinanceJson.Has(bag, FinanceKeys.PostedFor) && FinanceJson.Month(bag, FinanceKeys.PostedFor) is null))
        {
            return null;
        }
        var transaction = new FinanceTransaction(
            id,
            description,
            date,
            amount,
            account,
            FinanceJson.Id(bag, FinanceKeys.Line),
            FinanceJson.Text(bag, FinanceKeys.Source) ?? FinanceSources.Manual,
            FinanceJson.Month(bag, FinanceKeys.PostedFor),
            FinanceJson.Text(bag, FinanceKeys.ImportKey),
            FinanceJson.Bool(bag, FinanceKeys.Cleared) ?? false);
        return transaction.Validate() is null ? transaction : null;
    }

    public static bool Claims(string? json) => FinanceJson.Text(FinanceJson.Bag(json), FinanceKeys.Kind) == FinanceKinds.Transaction;
}
