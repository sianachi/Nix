using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>
/// The one check over a whole rule set: the ceiling, the single level of "any of" groups, and each
/// rule's grammar. Shared by the view write path, the saved-query run and the ad-hoc query, so a
/// rule set means the same thing - and is refused for the same reason - wherever it arrives.
/// </summary>
public static class QueryRules
{
    /// <summary>The most rules one set may hold, counting the rules inside groups.</summary>
    /// <remarks>
    /// Counted across both levels (queries plan 1.6) so a group cannot be used to step around the
    /// bound the statement's size and the editor's length were both sized to.
    /// </remarks>
    public const int MaximumRules = 8;

    /// <summary>The number of conditions in a set: each plain rule, plus each rule inside a group.</summary>
    /// <param name="rules">The set.</param>
    /// <returns>The count the ceiling applies to.</returns>
    public static int Count(ImmutableArray<FilterRule> rules)
    {
        if (rules.IsDefaultOrEmpty)
        {
            return 0;
        }

        var count = 0;
        foreach (var rule in rules)
        {
            count += rule.IsGroup ? rule.Any.Length : 1;
        }

        return count;
    }

    /// <summary>Every leaf rule of a set, top level and inside groups, in order.</summary>
    /// <param name="rules">The set.</param>
    /// <returns>The plain rules.</returns>
    public static IEnumerable<FilterRule> Leaves(ImmutableArray<FilterRule> rules)
    {
        if (rules.IsDefaultOrEmpty)
        {
            yield break;
        }

        foreach (var rule in rules)
        {
            if (rule.IsGroup)
            {
                foreach (var inner in rule.Any)
                {
                    yield return inner;
                }
            }
            else
            {
                yield return rule;
            }
        }
    }

    /// <summary>The sentence refusing a rule set, or null when it may be stored and run.</summary>
    /// <param name="rules">The set.</param>
    /// <param name="query">
    /// Whether the set belongs to a query (a query view, or the ad-hoc query endpoint). Only a
    /// query may test the structural <c>$</c> fields; see <see cref="QueryFields"/>.
    /// </param>
    /// <returns>How to finish "'&lt;view name&gt;': ...", or <see langword="null"/>.</returns>
    public static string? Refuse(ImmutableArray<FilterRule> rules, bool query)
    {
        if (rules.IsDefaultOrEmpty)
        {
            return null;
        }

        if (Count(rules) > MaximumRules)
        {
            return $"a view may carry at most {MaximumRules} filters, counting those inside \"any of\" groups";
        }

        foreach (var rule in rules)
        {
            if (!rule.IsGroup)
            {
                if (RefuseLeaf(rule, query) is { } reason)
                {
                    return reason;
                }

                continue;
            }

            // A group carries nothing of its own: a stray property or operator would be a second,
            // ignored meaning sitting beside the alternatives.
            if (rule.Property.Length != 0 || rule.Operator.Length != 0 || rule.Value.Length != 0)
            {
                return "an \"any of\" group holds only its rules, with no property, operator or value of its own";
            }

            foreach (var inner in rule.Any)
            {
                if (inner.IsGroup)
                {
                    return "\"any of\" groups do not nest; a group holds plain filters";
                }

                if (RefuseLeaf(inner, query) is { } reason)
                {
                    return reason;
                }
            }
        }

        return null;
    }

    private static string? RefuseLeaf(FilterRule rule, bool query)
    {
        if (QueryOperators.Refuse(rule) is { } reason)
        {
            return reason;
        }

        return !query && QueryFields.IsReserved(rule.Property)
            ? $"only a query can filter by '{rule.Property}'; a view filters its own children by their properties"
            : null;
    }
}
