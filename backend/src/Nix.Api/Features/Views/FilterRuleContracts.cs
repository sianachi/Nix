using System.Collections.Immutable;
using Nix.Domain.Views;

namespace Nix.Features.Views;

/// <summary>
/// Maps filter rules between the wire and the domain - for the views write path and the ad-hoc
/// query alike, so a rule is spelled one way on every route that carries one.
/// </summary>
internal static class FilterRuleContracts
{
    /// <summary>
    /// The sentence refusing a rule list's shape - a null where a field is owed - or null. Grammar
    /// is <see cref="QueryRules"/>' job once the list has been mapped.
    /// </summary>
    /// <param name="rules">The rules as sent, or null for none.</param>
    /// <returns>The reason, or <see langword="null"/>.</returns>
    internal static string? RefuseShape(IReadOnlyList<FilterRuleContract?>? rules)
    {
        if (rules is null)
        {
            return null;
        }

        foreach (var rule in rules)
        {
            if (rule is null)
            {
                return "every filter needs a property, an operator and a value, empty when the operator takes none";
            }

            if (rule.Any is null)
            {
                if (rule.Property is null || rule.Operator is null || rule.Value is null)
                {
                    return "every filter needs a property, an operator and a value, empty when the operator takes none";
                }

                continue;
            }

            if (rule.Any.Count == 0)
            {
                return "an \"any of\" group needs at least one filter";
            }

            foreach (var inner in rule.Any)
            {
                if (inner is null || inner.Any is not null)
                {
                    return "\"any of\" groups do not nest; a group holds plain filters";
                }

                if (inner.Property is null || inner.Operator is null || inner.Value is null)
                {
                    return "every filter needs a property, an operator and a value, empty when the operator takes none";
                }
            }
        }

        return null;
    }

    /// <summary>Maps rules whose shape <see cref="RefuseShape"/> has passed.</summary>
    /// <param name="rules">The rules as sent, or null for none.</param>
    /// <returns>The domain rules.</returns>
    internal static ImmutableArray<FilterRule> ToDomain(IReadOnlyList<FilterRuleContract>? rules)
    {
        if (rules is null || rules.Count == 0)
        {
            return [];
        }

        var mapped = ImmutableArray.CreateBuilder<FilterRule>(rules.Count);
        foreach (var rule in rules)
        {
            if (rule.Any is { } alternatives)
            {
                // A group's own fields are carried through, empty when absent, so QueryRules can
                // refuse a group that also tried to be a condition rather than dropping the stray.
                mapped.Add(new FilterRule(rule.Property ?? string.Empty, rule.Operator ?? string.Empty, rule.Value ?? string.Empty)
                {
                    Any = [.. alternatives.Select(inner => new FilterRule(inner.Property!, inner.Operator!, inner.Value!))],
                });
            }
            else
            {
                mapped.Add(new FilterRule(rule.Property!, rule.Operator!, rule.Value!));
            }
        }

        return mapped.ToImmutable();
    }

    /// <summary>Maps stored rules onto the wire: a plain rule's three fields, or a group's <c>any</c>.</summary>
    /// <param name="rules">The domain rules.</param>
    /// <returns>The published rules.</returns>
    internal static IReadOnlyList<FilterRuleContract> ToContract(ImmutableArray<FilterRule> rules)
    {
        if (rules.IsDefaultOrEmpty)
        {
            return [];
        }

        var mapped = new List<FilterRuleContract>(rules.Length);
        foreach (var rule in rules)
        {
            mapped.Add(rule.IsGroup
                ? new FilterRuleContract(null, null, null, [.. rule.Any.Select(inner => new FilterRuleContract(inner.Property, inner.Operator, inner.Value))])
                : new FilterRuleContract(rule.Property, rule.Operator, rule.Value));
        }

        return mapped;
    }
}
