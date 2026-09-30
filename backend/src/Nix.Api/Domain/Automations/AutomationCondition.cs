using System.Collections.Immutable;
using System.Text.Json.Nodes;

namespace Nix.Domain.Automations;

/// <summary>How a condition compares the triggering item's current value.</summary>
public enum AutomationConditionOperator
{
    /// <summary>The value equals the condition's value.</summary>
    EqualTo,

    /// <summary>The value does not equal the condition's value (an absent value never equals one).</summary>
    NotEqualTo,

    /// <summary>The value is absent, null, an empty string or an empty list.</summary>
    IsEmpty,

    /// <summary>The value is present and not empty.</summary>
    IsNotEmpty,
}

/// <summary>A check on the triggering item's current properties, made at fire time.</summary>
/// <param name="Key">The property checked.</param>
/// <param name="Operator">How it is compared.</param>
/// <param name="Value">What it is compared with; only for the two equality operators.</param>
public sealed record AutomationCondition(string Key, AutomationConditionOperator Operator, JsonNode? Value)
{
    /// <summary>Whether this condition holds for <paramref name="properties"/>.</summary>
    public bool IsMet(JsonObject? properties)
    {
        var current = properties is not null && properties.TryGetPropertyValue(Key, out var value) ? value : null;
        return Operator switch
        {
            AutomationConditionOperator.EqualTo => JsonNode.DeepEquals(current, Value),
            AutomationConditionOperator.NotEqualTo => !JsonNode.DeepEquals(current, Value),
            AutomationConditionOperator.IsEmpty => IsEmpty(current),
            AutomationConditionOperator.IsNotEmpty => !IsEmpty(current),
            _ => false,
        };
    }

    private static bool IsEmpty(JsonNode? value) => value switch
    {
        null => true,
        JsonArray array => array.Count == 0,
        JsonObject document => document.Count == 0,
        JsonValue text when text.TryGetValue<string>(out var s) => s.Length == 0,
        _ => false,
    };
}

/// <summary>Reads and writes a rule's condition list.</summary>
public static class AutomationConditionJson
{
    /// <summary>The most conditions one rule may carry.</summary>
    public const int MaximumConditions = 5;

    /// <summary>Reads a condition list; an absent list is an empty one.</summary>
    public static AutomationParse<ImmutableArray<AutomationCondition>> ReadAll(JsonNode? node)
    {
        if (node is null)
        {
            return new AutomationParse<ImmutableArray<AutomationCondition>>([], []);
        }

        var violations = new List<AutomationViolation>();
        if (node is not JsonArray array)
        {
            violations.Add(new AutomationViolation("conditions", "must be a list"));
            return new AutomationParse<ImmutableArray<AutomationCondition>>([], [.. violations]);
        }

        if (array.Count > MaximumConditions)
        {
            violations.Add(new AutomationViolation("conditions", "may hold at most five conditions"));
        }

        var conditions = ImmutableArray.CreateBuilder<AutomationCondition>(array.Count);
        for (var index = 0; index < array.Count; index++)
        {
            var path = $"conditions[{index}]";
            if (array[index] is not JsonObject entry)
            {
                violations.Add(new AutomationViolation(path, "must be an object"));
                continue;
            }

            var before = violations.Count;
            AutomationJsonRead.RefuseUnknown(entry, path, violations, "key", "op", "value");
            var key = AutomationJsonRead.String(entry, "key", path, violations);
            AutomationJsonRead.CheckKey(key, $"{path}.key", violations);
            var opText = AutomationJsonRead.String(entry, "op", path, violations);
            AutomationConditionOperator? op = opText switch
            {
                null => null,
                "equals" => AutomationConditionOperator.EqualTo,
                "not_equals" => AutomationConditionOperator.NotEqualTo,
                "is_empty" => AutomationConditionOperator.IsEmpty,
                "is_not_empty" => AutomationConditionOperator.IsNotEmpty,
                _ => null,
            };
            if (opText is not null && op is null)
            {
                violations.Add(new AutomationViolation($"{path}.op", "must be equals, not_equals, is_empty or is_not_empty"));
            }

            var comparesValue = op is AutomationConditionOperator.EqualTo or AutomationConditionOperator.NotEqualTo;
            if (op is not null && comparesValue != entry.ContainsKey("value"))
            {
                violations.Add(new AutomationViolation($"{path}.value", comparesValue ? "is required for this operator" : "is not allowed for this operator"));
            }

            if (AutomationJsonRead.Bytes(entry["value"]) > 1024)
            {
                violations.Add(new AutomationViolation($"{path}.value", "must be at most 1 KiB"));
            }

            if (violations.Count == before && key is not null && op is not null)
            {
                conditions.Add(new AutomationCondition(key, op.Value, entry["value"]?.DeepClone()));
            }
        }

        return violations.Count == 0
            ? new AutomationParse<ImmutableArray<AutomationCondition>>(conditions.ToImmutable(), [])
            : new AutomationParse<ImmutableArray<AutomationCondition>>([], [.. violations]);
    }

    /// <summary>Writes a condition list in its stored shape.</summary>
    public static JsonArray WriteAll(IEnumerable<AutomationCondition> conditions)
    {
        ArgumentNullException.ThrowIfNull(conditions);
        var array = new JsonArray();
        foreach (var condition in conditions)
        {
            var entry = new JsonObject
            {
                ["key"] = condition.Key,
                ["op"] = condition.Operator switch
                {
                    AutomationConditionOperator.EqualTo => "equals",
                    AutomationConditionOperator.NotEqualTo => "not_equals",
                    AutomationConditionOperator.IsEmpty => "is_empty",
                    _ => "is_not_empty",
                },
            };
            if (condition.Operator is AutomationConditionOperator.EqualTo or AutomationConditionOperator.NotEqualTo)
            {
                entry["value"] = condition.Value?.DeepClone();
            }

            array.Add(entry);
        }

        return array;
    }
}
