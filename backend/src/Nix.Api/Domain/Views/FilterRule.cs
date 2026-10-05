using System.Collections.Immutable;
using System.Globalization;

namespace Nix.Domain.Views;

/// <summary>
/// One condition of a query view: a property, an operator, and the value the operator reads.
/// </summary>
/// <param name="Property">The property key the condition tests, matched across containers.</param>
/// <param name="Operator">One of <see cref="QueryOperators"/>' closed set.</param>
/// <param name="Value">
/// What the operator compares against, in the operator's own grammar - a literal for the equality
/// pair (or <c>me</c>, resolved to the calling principal), <c>today</c> or <c>yyyy-MM-dd</c> for
/// the date trio, a day count for <c>within-next</c>.
/// </param>
/// <remarks>
/// <para>
/// <b>Validated per operator, never per property type.</b> A query view spans containers, so
/// there is no single schema to check the key against - the same argument
/// <c>SetContainerViewsHandler.Refuse</c> makes for a board configured before its property is
/// declared. A rule naming a property nothing declares simply matches nothing.
/// </para>
/// <para>
/// <b>Rules combine with AND only.</b> The shipped presets need nothing more (Overdue is
/// <c>due before today</c> AND <c>done not-equals true</c>), and OR would double the compiler,
/// the validator and the editor for a case no preset exercises. ADR-0039 records the decision.
/// </para>
/// </remarks>
public sealed record FilterRule(string Property, string Operator, string Value);

/// <summary>
/// The operators a query view may use, and each one's value grammar.
/// </summary>
/// <remarks>
/// A closed set, policed on write and re-checked before execution: each operator selects a fixed
/// SQL fragment in <c>QuerySql</c>, so an operator outside this set has no fragment to select and
/// a value outside its grammar has no meaning to compile. Sized to the shipped presets plus a
/// select filter, deliberately - every operator added here is also an editor control, a
/// compilation arm and a sentence in the published contract.
/// </remarks>
public static class QueryOperators
{
    /// <summary>The stored value equals the literal.</summary>
    public const string EqualTo = "equals";

    /// <summary>The stored value differs from the literal - including being absent.</summary>
    /// <remarks>
    /// Absence counts as "not equal" on purpose: Overdue asks for <c>done not-equals true</c>,
    /// and an item that never had the property set is exactly as not-done as one set false.
    /// </remarks>
    public const string NotEqualTo = "not-equals";

    /// <summary>The stored date falls on the day.</summary>
    public const string On = "on";

    /// <summary>The stored date falls before the day.</summary>
    public const string Before = "before";

    /// <summary>The stored date falls on or after the day.</summary>
    public const string OnOrAfter = "on-or-after";

    /// <summary>The stored date falls within the next N days, today included.</summary>
    public const string WithinNext = "within-next";

    /// <summary>
    /// For text, the stored value contains the literal as a substring, ignoring case. For a
    /// multi-select, the literal is one of the stored options exactly, case included - an option
    /// is a declared name, not text to search.
    /// </summary>
    /// <remarks>
    /// Evaluated today only by the web, over a container's own children
    /// (<c>apps/web/src/views/core/filter-rules.ts</c>), whose tests pin both halves; the SQL arm
    /// arrives with ADR-0055 and must keep this meaning.
    /// </remarks>
    public const string Contains = "contains";

    /// <summary>The negation of <see cref="Contains"/>, absence included.</summary>
    public const string NotContains = "not-contains";

    /// <summary>The stored number is greater than the literal.</summary>
    public const string GreaterThan = "greater-than";

    /// <summary>The stored number is less than the literal.</summary>
    public const string LessThan = "less-than";

    /// <summary>The property is absent, empty text or an empty list. Takes no value.</summary>
    public const string IsEmpty = "is-empty";

    /// <summary>The negation of <see cref="IsEmpty"/>. Takes no value.</summary>
    public const string IsNotEmpty = "is-not-empty";

    /// <summary>The token a stored rule keeps where a concrete day would go.</summary>
    /// <remarks>
    /// Resolved at read time from the caller's own <c>today</c> parameter, never from the server
    /// clock: only the reader's zone decides which day "today" is, and a saved query has to stay
    /// saved as the rule rather than as whichever day it was written on.
    /// </remarks>
    public const string Today = "today";

    /// <summary>The token a stored rule keeps where the calling principal's identifier would go.</summary>
    /// <remarks>
    /// <para>
    /// <b>Valid only as the value of <see cref="EqualTo"/> or <see cref="NotEqualTo"/>.</b> None
    /// of the day operators or <see cref="WithinNext"/> read an identity, so a rule that names
    /// <c>me</c> there is refused by the same grammar that refuses any other malformed day or
    /// count - it is neither <see cref="Today"/> nor a calendar day, and it does not parse as a
    /// number, so no separate check is needed to keep it out of those arms.
    /// </para>
    /// <para>
    /// <b>Resolved from the session context the request pipeline established, never from
    /// anything a client sends.</b> This is the one place the parallel with <see cref="Today"/>
    /// breaks: <c>today</c>'s caller is the reader's own clock, sent because only the reader's
    /// zone knows the day, but letting a client assert <em>its own identity</em> inside a filter
    /// value would make "assigned to me" mean whatever the request claimed rather than who
    /// actually asked. <c>RunItemQueryHandler</c> resolves it from the acting principal and
    /// rewrites the rule before the compiled statement ever sees it, so by the time a value
    /// reaches <c>QuerySql</c> it is already a literal - the same reason <c>QuerySql</c> carries
    /// no <c>me</c>-handling branch of its own; it is a static compiler with no session to read
    /// one from.
    /// </para>
    /// </remarks>
    public const string Me = "me";

    /// <summary>
    /// Every operator a rule's <c>Operator</c> may hold - not <see cref="Today"/> or
    /// <see cref="Me"/>, which are value tokens, never an operator.
    /// </summary>
    public static readonly ImmutableArray<string> All =
        [EqualTo, NotEqualTo, On, Before, OnOrAfter, WithinNext,
            Contains, NotContains, GreaterThan, LessThan, IsEmpty, IsNotEmpty];

    /// <summary>
    /// The operators a query view's SQL compiles today - <see cref="All"/> before ADR-0054 widened
    /// it for container views.
    /// </summary>
    /// <remarks>
    /// A container view evaluates its rules over children already read, so every operator in
    /// <see cref="All"/> is meaningful there. A query view compiles its rules to SQL, and
    /// <c>QuerySql</c> has an arm for these and no others; a query view naming one of the rest is
    /// refused on write and refused again before it runs, rather than reaching the compiler's
    /// "unknown operator" throw.
    /// </remarks>
    public static readonly ImmutableArray<string> CompiledByQuery =
        [EqualTo, NotEqualTo, On, Before, OnOrAfter, WithinNext];

    /// <summary>Whether an operator takes no value at all.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the emptiness pair.</returns>
    public static bool TakesNoValue(string @operator) => @operator is IsEmpty or IsNotEmpty;

    /// <summary>Whether an operator reads its value as a number.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the numeric comparisons.</returns>
    public static bool ReadsNumber(string @operator) => @operator is GreaterThan or LessThan;

    /// <summary>The most days <see cref="WithinNext"/> may look ahead.</summary>
    public const int MaximumWithinDays = 365;

    /// <summary>The longest value a rule may carry, in characters.</summary>
    public const int MaximumValueLength = 512;

    /// <summary>The longest property key a rule may name, in characters.</summary>
    public const int MaximumPropertyLength = 128;

    /// <summary>Whether the operator is one this build defines.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> when it selects a compilation arm.</returns>
    public static bool IsKnown(string @operator) => All.Contains(@operator);

    /// <summary>Whether the operator reads its value as a day.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the date trio; <see cref="WithinNext"/> reads a count.</returns>
    public static bool ReadsDay(string @operator) => @operator is On or Before or OnOrAfter;

    /// <summary>
    /// The sentence refusing one rule, or null when the rule is storable.
    /// </summary>
    /// <param name="rule">The rule.</param>
    /// <returns>How to finish "'&lt;view name&gt;': ...", or <see langword="null"/>.</returns>
    /// <remarks>
    /// Grammar only - key length, operator membership, value shape. Whether the property exists
    /// is deliberately not asked; see <see cref="FilterRule"/>.
    /// </remarks>
    public static string? Refuse(FilterRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);

        if (rule.Property.Length == 0)
        {
            return "a filter needs a property to test";
        }

        if (rule.Property.Length > MaximumPropertyLength)
        {
            return $"a filter's property key may be at most {MaximumPropertyLength} characters";
        }

        if (!IsKnown(rule.Operator))
        {
            return $"'{rule.Operator}' is not a filter operator";
        }

        if (TakesNoValue(rule.Operator))
        {
            // Nothing to compare against, and a value here would be a second, ignored meaning.
            return rule.Value.Length == 0 ? null : $"'{rule.Operator}' takes no value";
        }

        if (rule.Value.Length == 0)
        {
            return "a filter needs a value to compare against";
        }

        if (rule.Value.Length > MaximumValueLength)
        {
            return $"a filter's value may be at most {MaximumValueLength} characters";
        }

        if (ReadsDay(rule.Operator)
            && !string.Equals(rule.Value, Today, StringComparison.Ordinal)
            && !IsCalendarDay(rule.Value))
        {
            return $"'{rule.Operator}' reads a day: '{Today}' or a date written yyyy-MM-dd";
        }

        if (ReadsNumber(rule.Operator) && !IsFiniteNumber(rule.Value))
        {
            return $"'{rule.Operator}' reads a number, written like 12 or -3.5";
        }

        if (string.Equals(rule.Operator, WithinNext, StringComparison.Ordinal)
            && (!int.TryParse(rule.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var days)
                || days < 1
                || days > MaximumWithinDays))
        {
            return $"'{WithinNext}' reads a number of days from 1 to {MaximumWithinDays}";
        }

        return null;
    }

    private static bool IsFiniteNumber(string value) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
        && double.IsFinite(number);

    private static bool IsCalendarDay(string value) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
}
