using System.Text.Json.Nodes;

namespace Nix.Domain.Finance;

/// <summary>The settings on a finance root: the currency, the planning window and the opening cash.</summary>
/// <param name="Currency">An ISO 4217 code such as GBP; one per workspace.</param>
/// <param name="StartMonth">The first planned month. Opening balances are as at the day before it.</param>
/// <param name="HorizonMonths">How many months the plan and projection cover, from the start.</param>
/// <param name="OpeningCash">Cash across current and savings accounts the day before the start month.</param>
/// <param name="EmergencyFundMonths">Months of planned outgoings to hold as the emergency target.</param>
/// <param name="Timezone">Where "today" is decided, for what counts as the current month.</param>
public sealed record FinanceSettings(
    string Currency,
    YearMonth StartMonth,
    int HorizonMonths,
    decimal OpeningCash,
    decimal EmergencyFundMonths,
    string Timezone)
{
    public const int MaximumHorizonMonths = 120;
    public const decimal MaximumEmergencyFundMonths = 36;

    /// <summary>The last month inside the horizon.</summary>
    public YearMonth EndMonth => StartMonth.AddMonths(HorizonMonths - 1);

    public bool Covers(YearMonth month) => month >= StartMonth && month <= EndMonth;

    public DateOnly Today(DateTimeOffset now) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(Timezone)).DateTime);

    /// <summary>The current month, clamped into the horizon so every figure has a month to stand on.</summary>
    public YearMonth CurrentMonth(DateTimeOffset now)
    {
        var month = YearMonth.Of(Today(now));
        return month < StartMonth ? StartMonth : month > EndMonth ? EndMonth : month;
    }

    public string? Validate()
    {
        if (!MoneyRules.IsCurrency(Currency))
        {
            return "Currency must be a three-letter ISO code such as GBP.";
        }
        if (HorizonMonths is < 1 or > MaximumHorizonMonths)
        {
            return $"The horizon must be between 1 and {MaximumHorizonMonths} months.";
        }
        if (StartMonth.Year is < 1970 or > 2200)
        {
            return "The start month must be between 1970 and 2200.";
        }
        if (!MoneyRules.IsAmount(OpeningCash))
        {
            return "Opening cash must be an amount with at most two decimal places.";
        }
        if (EmergencyFundMonths < 0 || EmergencyFundMonths > MaximumEmergencyFundMonths || decimal.Round(EmergencyFundMonths, 1) != EmergencyFundMonths)
        {
            return $"The emergency fund target must be between 0 and {MaximumEmergencyFundMonths} months, to one decimal place.";
        }
        if (string.IsNullOrWhiteSpace(Timezone) || Timezone.Length > 128 || !TimeZoneInfo.TryFindSystemTimeZoneById(Timezone, out _))
        {
            return "Choose a valid timezone.";
        }
        return null;
    }

    public JsonObject ToProperties() => new()
    {
        [FinanceKeys.Currency] = Currency,
        [FinanceKeys.StartMonth] = StartMonth.ToString(),
        [FinanceKeys.HorizonMonths] = HorizonMonths,
        [FinanceKeys.OpeningCash] = OpeningCash,
        [FinanceKeys.EmergencyFundMonths] = EmergencyFundMonths,
        [FinanceKeys.Timezone] = Timezone,
    };

    /// <summary>The settings, or null when the bag holds none or holds an invalid set.</summary>
    public static FinanceSettings? Read(string? json) => Read(FinanceJson.Bag(json));

    public static FinanceSettings? Read(JsonObject bag)
    {
        if (FinanceJson.Text(bag, FinanceKeys.Currency) is not { } currency
            || FinanceJson.Month(bag, FinanceKeys.StartMonth) is not { } start
            || FinanceJson.Whole(bag, FinanceKeys.HorizonMonths) is not { } horizon
            || FinanceJson.Amount(bag, FinanceKeys.OpeningCash) is not { } cash
            || FinanceJson.Amount(bag, FinanceKeys.EmergencyFundMonths) is not { } emergency
            || FinanceJson.Text(bag, FinanceKeys.Timezone) is not { } timezone)
        {
            return null;
        }
        var settings = new FinanceSettings(currency, start, horizon, cash, emergency, timezone);
        return settings.Validate() is null ? settings : null;
    }

    /// <summary>Whether a bag has been given finance settings at all, valid or not.</summary>
    public static bool IsConfigured(string? json) => FinanceJson.Has(FinanceJson.Bag(json), FinanceKeys.Currency);
}

/// <summary>Where a finance root keeps its records: the identifiers of its three containers.</summary>
public sealed record FinanceContainers(Guid Accounts, Guid Lines, Guid Transactions)
{
    public JsonObject ToProperties() => new()
    {
        [FinanceKeys.AccountsContainer] = Accounts.ToString("D"),
        [FinanceKeys.LinesContainer] = Lines.ToString("D"),
        [FinanceKeys.TransactionsContainer] = Transactions.ToString("D"),
    };

    public static FinanceContainers? Read(JsonObject bag) =>
        FinanceJson.Id(bag, FinanceKeys.AccountsContainer) is { } accounts
        && FinanceJson.Id(bag, FinanceKeys.LinesContainer) is { } lines
        && FinanceJson.Id(bag, FinanceKeys.TransactionsContainer) is { } transactions
            ? new FinanceContainers(accounts, lines, transactions)
            : null;
}
