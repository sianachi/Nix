namespace Nix.Domain.Finance;

/// <summary>One month of cash as it actually moves: what came in, what left, and where that leaves the bank.</summary>
/// <param name="Source">Whether the month reads from the plan or from its transactions.</param>
/// <param name="CardPaymentOut">Last month's card statements, collected this month.</param>
/// <param name="CashNet">Income less what left the bank, including those statements.</param>
/// <param name="ClosingBank">Cash at the end of the month.</param>
/// <param name="CardOwed">What the cards are owed at the end of the month, collected next month.</param>
/// <param name="NetPosition">Bank less what the cards are owed: the honest number.</param>
/// <param name="EmergencyTarget">Months of planned outgoings to hold for this month.</param>
/// <param name="BufferMet">Whether the net position covers the emergency target.</param>
public sealed record CashFlowMonth(
    YearMonth Month,
    FigureSource Source,
    decimal Income,
    decimal PaidThisMonth,
    decimal CardSpend,
    decimal CardPaymentOut,
    decimal CashNet,
    decimal ClosingBank,
    decimal CardOwed,
    decimal NetPosition,
    decimal EmergencyTarget,
    bool BufferMet);

/// <summary>The projection from the start month to the end of the horizon.</summary>
/// <param name="OpeningBank">Cash the day before the start month.</param>
/// <param name="OpeningCardOwed">What the cards were owed the day before the start month.</param>
/// <param name="EmergencyTarget">Months of outgoings to hold, priced from <paramref name="EmergencyBasisMonth"/>'s plan.</param>
/// <param name="BufferMetIn">The first month the net position covers the target, if any.</param>
public sealed record CashFlowProjection(
    decimal OpeningBank,
    decimal OpeningCardOwed,
    decimal OpeningNetPosition,
    decimal EmergencyTarget,
    YearMonth EmergencyBasisMonth,
    YearMonth? BufferMetIn,
    IReadOnlyList<CashFlowMonth> Months)
{
    public CashFlowMonth? For(YearMonth month) => Months.FirstOrDefault(row => row.Month == month);
}

/// <summary>
/// Money in the month it actually moves.
/// </summary>
/// <remarks>
/// Cards are paid in arrears: what leaves in a month is the previous month's card spend, and in
/// the start month it is the balance carried in. Closed months read from their transactions and
/// open months from the plan, so closing a month re-chains every month after it. Two numbers
/// are true at once: the closing bank is cash that can be seen, and the net position is that
/// cash less what the cards are still owed. The second is the one that moves by the budget's net.
/// </remarks>
public static class CashFlowProjections
{
    public static CashFlowProjection Compute(FinanceBook book, YearMonth emergencyBasisMonth)
    {
        ArgumentNullException.ThrowIfNull(book);
        var settings = book.Settings;
        var cards = CardCycles.ComputeAll(book, FigureSource.Auto, settings.StartMonth, settings.EndMonth);
        var openingCardOwed = book.Cards.Sum(card => card.OpeningBalance);
        var target = MoneyRules.Round(settings.EmergencyFundMonths * book.Figures(emergencyBasisMonth, FigureSource.Plan).Outgoings);
        var rows = new List<CashFlowMonth>();
        var bank = settings.OpeningCash;
        YearMonth? bufferMetIn = null;
        foreach (var month in YearMonth.Range(settings.StartMonth, settings.EndMonth))
        {
            var source = book.Resolve(FigureSource.Auto, month);
            var figures = book.Figures(month, source);
            var cardPaymentOut = cards.Sum(cycle => cycle.For(month)?.PaymentOut ?? 0);
            var cardOwed = cards.Sum(cycle => cycle.For(month)?.Closing ?? 0);
            var cashNet = figures.Income - figures.PaidThisMonth - cardPaymentOut;
            bank += cashNet;
            var netPosition = bank - cardOwed;
            var monthTarget = MoneyRules.Round(settings.EmergencyFundMonths * book.Figures(month, FigureSource.Plan).Outgoings);
            var met = monthTarget > 0 && netPosition >= monthTarget;
            if (met && bufferMetIn is null)
            {
                bufferMetIn = month;
            }
            rows.Add(new CashFlowMonth(month, source, figures.Income, figures.PaidThisMonth, figures.CardSpend, cardPaymentOut, cashNet, bank, cardOwed, netPosition, monthTarget, met));
        }
        return new CashFlowProjection(settings.OpeningCash, openingCardOwed, settings.OpeningCash - openingCardOwed, target, emergencyBasisMonth, bufferMetIn, rows);
    }
}
