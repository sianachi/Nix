using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Features.Properties;

/// <summary>
/// The refusal both generic property write paths give a key in the reserved <c>$</c> space.
/// </summary>
/// <remarks>
/// <para>
/// <b>The <c>$</c> prefix belongs to the server.</b> The system keys already live there
/// (<c>$habit_</c>, <c>$cal_</c>, <c>$fin_</c>, the set-by stamps), each written only by its own
/// trusted dispatch, and the queries plan (D2) spells structural query fields the same way
/// (<see cref="QueryFields"/>: <c>$type</c>, <c>$inside</c>, ...). A client key such as
/// <c>$type</c> could never be filtered on as itself, and one such as <c>$habit_x</c> would
/// impersonate a system key, so a generic write may not set any of them. Exactly three paths
/// refuse here: a schema declaration (<c>PropertySchemaRules</c>), <c>CreateItem</c> and
/// <c>SetItemProperties</c>. The template draft edit, capture and document import paths write
/// bags without passing through them.
/// </para>
/// <para>
/// <b>Setting is refused; clearing is not.</b> A bag that already holds a <c>$</c> key a client
/// wrote before this rule existed can still be emptied of it, so the rule never strands data.
/// </para>
/// <para>
/// Checked after <see cref="SchedulingReservedProperties"/> and the finance check, so the keys
/// those already refuse keep their own codes.
/// </para>
/// </remarks>
internal static class ReservedPropertyKeys
{
    /// <summary>The finance endpoints' prefix, spelled where the finance check spells it.</summary>
    private const string FinancePrefix = "$fin_";

    /// <summary>Whether a generic write may not set <paramref name="key"/>.</summary>
    /// <param name="key">The property key the write sets.</param>
    /// <param name="habitWrite">A trusted habit dispatch, which may set <c>$habit_</c> keys.</param>
    /// <param name="calendarWrite">A trusted calendar sync dispatch, which may set <c>$cal_</c> keys.</param>
    /// <param name="financeWrite">A trusted finance dispatch, which may set <c>$fin_</c> keys.</param>
    /// <returns><see langword="true"/> when the key is reserved and this write is not trusted with it.</returns>
    internal static bool IsRefused(string key, bool habitWrite, bool calendarWrite, bool financeWrite)
    {
        ArgumentNullException.ThrowIfNull(key);

        return QueryFields.IsReserved(key)
            && !(habitWrite && key.StartsWith(ItemProperties.HabitPrefix, StringComparison.Ordinal))
            && !(calendarWrite && key.StartsWith(ItemProperties.CalendarPrefix, StringComparison.Ordinal))
            && !(financeWrite && key.StartsWith(FinancePrefix, StringComparison.Ordinal));
    }

    /// <summary>The error naming the reserved key a write tried to set.</summary>
    /// <param name="key">The key.</param>
    /// <returns>An invalid-properties error whose violation names the key.</returns>
    internal static NixError Refusal(string key) =>
        PropertyErrors.InvalidProperties(
        [
            new PropertyViolation(
                key,
                $"A property key may not start with '{QueryFields.Prefix}'; that prefix is reserved for the server and for query fields such as {QueryFields.Type}."),
        ]);
}
