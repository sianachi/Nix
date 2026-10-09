using System.Collections.Immutable;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Views;

namespace Nix.Features.Query;

/// <summary>
/// The rule handling both query paths share - the saved query view and the ad-hoc workspace query
/// - so the rules mean the same thing whichever route sent them: one validation, one <c>me</c>
/// resolution, one ordering rule, then one statement (<c>QuerySql</c>).
/// </summary>
/// <remarks>
/// Pure functions over rules rather than a service: what differs between the two paths is where
/// the rules come from and which workspaces they run over, and both of those are the handlers'
/// business. What must not differ is everything here.
/// </remarks>
internal static class QueryEvaluation
{
    /// <summary>Reads a caller's today, exact-parsed.</summary>
    /// <param name="text">The day as sent, <c>yyyy-MM-dd</c>.</param>
    /// <param name="today">The day, when it parses.</param>
    /// <returns>Whether it parsed.</returns>
    /// <remarks>
    /// Exact, the calendar's own rule and reasons: a malformed day compares happily as text and
    /// would silently return nothing, which a reader reads as "nothing matches".
    /// </remarks>
    internal static bool TryParseToday(string? text, out DateOnly today) =>
        DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out today)
        && today >= EarliestToday
        && today <= LatestToday;

    /// <summary>The earliest day a caller may say is today.</summary>
    /// <remarks>
    /// Bounded both ways so every token and window resolved from it (a year of days either side,
    /// a month back) stays inside the calendar: an unbounded today let 9999-12-31 plus seven days
    /// throw, which reached the caller as a 500.
    /// </remarks>
    internal static readonly DateOnly EarliestToday = new(1900, 1, 1);

    /// <summary>The latest day a caller may say is today.</summary>
    internal static readonly DateOnly LatestToday = new(9000, 12, 31);

    /// <summary>The sentence refusing a today outside the bounds or not a day at all.</summary>
    /// <param name="text">The day as sent.</param>
    /// <returns>The refusal's detail.</returns>
    internal static string TodayRefusal(string? text) =>
        $"'{text}' is not a day between 1900-01-01 and 9000-12-31; send today as yyyy-MM-dd.";

    /// <summary>
    /// The caller's zone for <c>$created</c> and <c>$modified</c>: their preferences' zone, UTC when
    /// they have none or it names no zone this build knows. Read only when a rule needs it.
    /// </summary>
    /// <param name="rules">The rules.</param>
    /// <param name="preferences">The caller's preferences store.</param>
    /// <param name="caller">The acting principal.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The zone.</returns>
    internal static async ValueTask<NodaTime.DateTimeZone> ZoneAsync(
        ImmutableArray<FilterRule> rules,
        IPrincipalPreferencesStore preferences,
        NixSessionContext caller,
        CancellationToken cancellationToken)
    {
        if (!QueryRules.Leaves(rules).Any(rule => QueryFields.IsDay(rule.Property)))
        {
            return NodaTime.DateTimeZone.Utc;
        }

        var stored = await preferences.FindAsync(caller.TenantId, caller.PrincipalId, cancellationToken).ConfigureAwait(false);
        return stored?.TimeZone is { Length: > 0 } name
            && NodaTime.DateTimeZoneProviders.Tzdb.GetZoneOrNull(name) is { } zone
            ? zone
            : NodaTime.DateTimeZone.Utc;
    }

    /// <summary>The sentence refusing a query's rules, or null when they may run.</summary>
    /// <param name="rules">The rules, plain and grouped.</param>
    /// <returns>The reason, or <see langword="null"/>.</returns>
    internal static string? Refuse(ImmutableArray<FilterRule> rules) => QueryRules.Refuse(rules, query: true);

    /// <summary>Whether any rule needs the caller's today to be compiled.</summary>
    /// <param name="rules">The rules.</param>
    /// <returns><see langword="true"/> when a token or a window appears.</returns>
    internal static bool NeedsToday(ImmutableArray<FilterRule> rules) =>
        QueryRules.Leaves(rules).Any(QueryOperators.NeedsToday);

    /// <summary>
    /// Replaces <see cref="QueryOperators.Me"/> with the caller's own canonical identifier wherever
    /// it is the value of an equality - the exact lowercase text an <c>assignee</c> property
    /// stores (<c>PrincipalId.ToString()</c>), so the comparison downstream actually matches.
    /// </summary>
    /// <param name="rules">The validated rules, plain and grouped.</param>
    /// <param name="callerId">The acting principal's canonical identifier, from the session - never the client.</param>
    /// <returns>The rules with every equality <c>me</c> replaced; everything else untouched.</returns>
    /// <remarks>
    /// Only equalities: <c>me</c> means the caller only where a rule compares identity. Under
    /// <c>contains</c> it is two letters of text, and rewriting it there would make
    /// "title contains me" search for the caller's id.
    /// </remarks>
    internal static ImmutableArray<FilterRule> ResolveCaller(ImmutableArray<FilterRule> rules, string callerId)
    {
        if (rules.IsDefaultOrEmpty)
        {
            return rules;
        }

        var resolved = ImmutableArray.CreateBuilder<FilterRule>(rules.Length);
        foreach (var rule in rules)
        {
            resolved.Add(rule.IsGroup
                ? FilterRule.Group(ResolveCaller(rule.Any, callerId))
                : ResolveLeaf(rule, callerId));
        }

        return resolved.ToImmutable();
    }

    /// <summary>
    /// How the rows are ordered: an explicit order when the caller gave one; else the first
    /// top-level date-shaped rule's property ascending - soonest first, which is what Today,
    /// Next-7-days and Overdue all want; else the fallback (a saved view's own sort); else most
    /// recently modified first.
    /// </summary>
    /// <param name="rules">The rules.</param>
    /// <param name="explicitOrder">The ad-hoc request's own sort, which wins outright.</param>
    /// <param name="fallbackOrder">A saved view's sort, which a date rule outranks.</param>
    /// <returns>The order.</returns>
    /// <remarks>
    /// Only top-level rules choose the date order: a date inside an "any of" group may not hold
    /// for a given row, so it cannot say what the whole list is ordered by.
    /// </remarks>
    internal static QueryOrder ResolveOrder(
        ImmutableArray<FilterRule> rules,
        QueryOrder? explicitOrder,
        QueryOrder? fallbackOrder)
    {
        if (explicitOrder is not null)
        {
            return explicitOrder;
        }

        if (!rules.IsDefaultOrEmpty)
        {
            foreach (var rule in rules)
            {
                if (!rule.IsGroup && QueryOperators.IsDateShaped(rule.Operator))
                {
                    return new QueryOrder(rule.Property, IsDay: true, Descending: false);
                }
            }
        }

        return fallbackOrder ?? QueryOrder.Recency;
    }

    private static FilterRule ResolveLeaf(FilterRule rule, string callerId) =>
        rule.Operator is QueryOperators.EqualTo or QueryOperators.NotEqualTo
        && string.Equals(rule.Value, QueryOperators.Me, StringComparison.Ordinal)
            ? rule with { Value = callerId }
            : rule;
}
