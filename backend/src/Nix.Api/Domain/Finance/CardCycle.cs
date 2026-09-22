namespace Nix.Domain.Finance;

/// <summary>One month of a card paid in full: what was owed, what went on, what was collected, what is owed now.</summary>
/// <param name="Utilisation">Closing balance over the limit, or null without a limit.</param>
public sealed record CardMonth(YearMonth Month, FigureSource Source, decimal Opening, decimal Spend, decimal PaymentOut, decimal Closing, decimal? Utilisation);

public sealed record CardCycle(FinanceAccount Card, IReadOnlyList<CardMonth> Months)
{
    /// <summary>The month's row, or null outside the cycle.</summary>
    public CardMonth? For(YearMonth month) => Months.FirstOrDefault(row => row.Month == month);
}

/// <summary>
/// The timing of a card paid in full: this month's spend is collected next month.
/// </summary>
/// <remarks>
/// The balance carried into the start month is collected in the start month, and every month
/// after that collects the month before it. Nothing here is debt; it is a float, cash that has
/// to be kept aside and never counted as savings, and the cash-flow projection excludes it on
/// purpose.
/// </remarks>
public static class CardCycles
{
    public static CardCycle Compute(FinanceBook book, FinanceAccount card, FigureSource source, YearMonth from, YearMonth to)
    {
        ArgumentNullException.ThrowIfNull(book);
        ArgumentNullException.ThrowIfNull(card);
        var rows = new List<CardMonth>();
        var opening = card.OpeningBalance;
        // The cycle chains from the start month whatever window is asked for, because the balance
        // carried into a later month is the spend of the month before it.
        foreach (var month in YearMonth.Range(book.Settings.StartMonth, to))
        {
            var resolved = book.Resolve(source, month);
            var spend = book.CardSpend(card, month, resolved);
            // The statement is paid in full only when there is a balance due. Card credits from
            // refunds carry forward against later spending; they do not become cash inflows.
            var payment = Math.Max(0, opening);
            var closing = opening + spend - payment;
            if (month >= from)
            {
                rows.Add(new CardMonth(month, resolved, opening, spend, payment, closing, card.Limit is { } limit && limit > 0 ? decimal.Round(closing / limit, 4) : null));
            }
            opening = closing;
        }
        return new CardCycle(card, rows);
    }

    public static IReadOnlyList<CardCycle> ComputeAll(FinanceBook book, FigureSource source, YearMonth from, YearMonth to)
    {
        ArgumentNullException.ThrowIfNull(book);
        return book.Cards.Select(card => Compute(book, card, source, from, to)).ToList();
    }
}
