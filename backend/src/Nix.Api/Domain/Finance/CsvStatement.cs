using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Domain.Finance;

/// <summary>One row of a bank statement, read as far as it can be.</summary>
/// <param name="Row">The 1-based line in the file, for the person to find it again.</param>
/// <param name="Amount">The cash effect, negative when money left, or null when unreadable.</param>
/// <param name="Problem">Why the row could not be read, when it could not.</param>
public sealed record StatementRow(int Row, DateOnly? Date, decimal? Amount, string Description, string? Problem)
{
    public bool IsReadable => Date is not null && Amount is not null && Problem is null;
}

public sealed record StatementParse(IReadOnlyList<StatementRow> Rows, string? Problem)
{
    public int Readable => Rows.Count(row => row.IsReadable);
}

/// <summary>
/// Reads the CSV a bank exports, without being told its layout.
/// </summary>
/// <remarks>
/// <para>
/// <b>Columns are found by their headers, not their positions.</b> Banks agree on almost
/// nothing except that the header row names the columns: a date, then either one signed amount
/// or a pair of money-in and money-out columns, and something descriptive. Each is matched from
/// a short list of the names in use; an export with none of them is refused with the headers it
/// did have, so the person can see why.
/// </para>
/// <para>
/// <b>Bounded.</b> A file is at most <see cref="MaximumBytes"/> and <see cref="MaximumRows"/>,
/// which is years of a personal account and far short of anything that would be a memory
/// concern. A row that cannot be read is reported with its line number and skipped, never
/// guessed at.
/// </para>
/// </remarks>
public static class CsvStatements
{
    public const int MaximumBytes = 1_048_576;
    public const int MaximumRows = 5000;
    public const int MaximumFields = 64;

    private static readonly string[] DateHeaders = ["date", "transaction date", "posting date", "booking date", "value date", "posted", "when"];
    private static readonly string[] AmountHeaders = ["amount", "value", "transaction amount", "amount (gbp)", "amount gbp"];
    private static readonly string[] InHeaders = ["money in", "paid in", "credit", "credit amount", "deposit", "in", "inflow"];
    private static readonly string[] OutHeaders = ["money out", "paid out", "debit", "debit amount", "withdrawal", "out", "outflow"];
    private static readonly string[] DescriptionHeaders = ["description", "narrative", "details", "memo", "payee", "name", "merchant", "reference", "transaction description", "transaction", "counterparty"];
    private static readonly string[] DateFormats = ["yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy", "dd-MM-yyyy", "d-M-yyyy", "dd MMM yyyy", "d MMM yyyy", "dd/MM/yy", "d/M/yy", "yyyy/MM/dd", "MM/dd/yyyy", "yyyyMMdd"];

    public static StatementParse Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (Encoding.UTF8.GetByteCount(text) > MaximumBytes)
        {
            return new StatementParse([], $"A statement is at most {MaximumBytes / 1024} KiB.");
        }
        var records = Split(text);
        if (records.Count == 0)
        {
            return new StatementParse([], "The file is empty.");
        }
        var header = records[0].Select(Normalise).ToList();
        var dateAt = Find(header, DateHeaders);
        var amountAt = Find(header, AmountHeaders);
        var inAt = Find(header, InHeaders);
        var outAt = Find(header, OutHeaders);
        var descriptionAt = Find(header, DescriptionHeaders);
        if (dateAt < 0 || (amountAt < 0 && (inAt < 0 || outAt < 0)))
        {
            return new StatementParse([], "The header row needs a date column and either an amount column or money-in and money-out columns. Found: " + string.Join(", ", records[0].Select(field => field.Length == 0 ? "(blank)" : field)) + ".");
        }
        if (records.Count - 1 > MaximumRows)
        {
            return new StatementParse([], $"A statement is at most {MaximumRows} rows.");
        }
        var rows = new List<StatementRow>();
        for (var index = 1; index < records.Count; index++)
        {
            var fields = records[index];
            if (fields.All(field => field.Length == 0))
            {
                continue;
            }
            var line = index + 1;
            var date = ParseDate(At(fields, dateAt));
            decimal? amount;
            string? problem = null;
            if (amountAt >= 0)
            {
                amount = ParseMoney(At(fields, amountAt));
                if (amount is null)
                {
                    problem = "The amount could not be read.";
                }
            }
            else
            {
                var moneyIn = ParseMoney(At(fields, inAt), allowBlank: true);
                var moneyOut = ParseMoney(At(fields, outAt), allowBlank: true);
                amount = moneyIn is null || moneyOut is null ? null : Math.Abs(moneyIn.Value) - Math.Abs(moneyOut.Value);
                if (amount is null)
                {
                    problem = "The money in or money out column could not be read.";
                }
            }
            if (date is null)
            {
                problem = "The date could not be read.";
            }
            else if (amount == 0)
            {
                problem = "The row moves no money.";
            }
            else if (amount is { } value && !MoneyRules.IsAmount(value))
            {
                problem = "The amount is outside what can be recorded.";
            }
            var description = descriptionAt >= 0 ? At(fields, descriptionAt).Trim() : string.Empty;
            if (description.Length == 0)
            {
                description = "Statement row";
            }
            if (description.Length > FinanceTransaction.MaximumDescriptionLength)
            {
                description = description[..FinanceTransaction.MaximumDescriptionLength];
            }
            rows.Add(new StatementRow(line, date, amount, description, problem));
        }
        return new StatementParse(rows, null);
    }

    /// <summary>
    /// The digest that says "this statement row": the account, the day, the amount and the
    /// description with its case and spacing flattened. The same row exported twice digests the
    /// same; two coffees on one day at one price digest the same too, which is the honest limit
    /// of what a statement without a reference can tell apart.
    /// </summary>
    public static string ImportKey(Guid accountId, DateOnly date, decimal amount, string description)
    {
        var text = string.Create(CultureInfo.InvariantCulture, $"{accountId:D}|{date:yyyy-MM-dd}|{amount:F2}|{Normalise(description)}");
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32];
    }

    /// <summary>The form a description is compared in: one case, single spaces, no punctuation noise.</summary>
    public static string Normalise(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var builder = new StringBuilder(text.Length);
        var space = false;
        foreach (var character in text.Trim().ToUpperInvariant())
        {
            if (char.IsLetterOrDigit(character))
            {
                builder.Append(character);
                space = false;
            }
            else if (!space && builder.Length > 0)
            {
                builder.Append(' ');
                space = true;
            }
        }
        return builder.ToString().TrimEnd();
    }

    private static string At(List<string> fields, int index) => index >= 0 && index < fields.Count ? fields[index] : string.Empty;

    private static int Find(List<string> header, string[] names)
    {
        foreach (var name in names)
        {
            var index = header.IndexOf(Normalise(name));
            if (index >= 0)
            {
                return index;
            }
        }
        return -1;
    }

    private static DateOnly? ParseDate(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }
        if (DateOnly.TryParseExact(trimmed, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
        {
            return day;
        }
        // A timestamp column still names a day.
        return DateTime.TryParse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var moment) ? DateOnly.FromDateTime(moment) : null;
    }

    private static decimal? ParseMoney(string text, bool allowBlank = false)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0)
        {
            return allowBlank ? 0 : null;
        }
        var negative = false;
        if (trimmed.StartsWith('(') && trimmed.EndsWith(')'))
        {
            negative = true;
            trimmed = trimmed[1..^1];
        }
        var builder = new StringBuilder(trimmed.Length);
        foreach (var character in trimmed)
        {
            if (char.IsDigit(character) || character == '.')
            {
                builder.Append(character);
            }
            else if (character == '-')
            {
                negative = !negative;
            }
            else if (character is not (',' or '+' or ' ') && !char.IsSymbol(character) && !char.IsLetter(character))
            {
                return null;
            }
        }
        if (!decimal.TryParse(builder.ToString(), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var value))
        {
            return null;
        }
        value = MoneyRules.Round(value);
        return negative ? -value : value;
    }

    private static List<List<string>> Split(string text)
    {
        var records = new List<List<string>>();
        var fields = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (quoted)
            {
                if (character == '"')
                {
                    if (index + 1 < text.Length && text[index + 1] == '"')
                    {
                        field.Append('"');
                        index++;
                    }
                    else
                    {
                        quoted = false;
                    }
                }
                else
                {
                    field.Append(character);
                }
                continue;
            }
            switch (character)
            {
                case '"':
                    quoted = true;
                    break;
                case ',':
                    fields.Add(field.ToString());
                    field.Clear();
                    break;
                case '\r':
                    break;
                case '\n':
                    fields.Add(field.ToString());
                    field.Clear();
                    if (fields.Count > MaximumFields)
                    {
                        fields = fields.Take(MaximumFields).ToList();
                    }
                    records.Add(fields);
                    fields = [];
                    break;
                default:
                    field.Append(character);
                    break;
            }
        }
        if (field.Length > 0 || fields.Count > 0)
        {
            fields.Add(field.ToString());
            records.Add(fields);
        }
        return records;
    }
}
