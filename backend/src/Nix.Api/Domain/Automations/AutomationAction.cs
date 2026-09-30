using System.Collections.Immutable;
using System.Text.Json.Nodes;

namespace Nix.Domain.Automations;

/// <summary>What an action reference points at.</summary>
public enum AutomationItemReferenceKind
{
    /// <summary>The item whose change or date fired the rule.</summary>
    TriggeringItem,

    /// <summary>The rule's scope item.</summary>
    Scope,

    /// <summary>A named item in the rule's workspace.</summary>
    Item,
}

/// <summary>An item an action acts on or under.</summary>
/// <param name="Kind">Which item.</param>
/// <param name="ItemId">The item, for <see cref="AutomationItemReferenceKind.Item"/> only.</param>
public sealed record AutomationItemReference(AutomationItemReferenceKind Kind, Guid? ItemId)
{
    /// <summary>Gets the reference to the triggering item.</summary>
    public static AutomationItemReference Triggering { get; } = new(AutomationItemReferenceKind.TriggeringItem, null);

    /// <summary>Gets the reference to the rule's scope item.</summary>
    public static AutomationItemReference RuleScope { get; } = new(AutomationItemReferenceKind.Scope, null);
}

/// <summary>One step a rule takes when it fires. A rule's actions are all-or-nothing.</summary>
public abstract record AutomationAction
{
    /// <summary>Gets the storage spelling of this action's type.</summary>
    public abstract string TypeText { get; }
}

/// <summary>Sets (or, with a null value, clears) one property on an item.</summary>
public sealed record SetPropertyAction(AutomationItemReference Target, string Key, JsonNode? Value) : AutomationAction
{
    /// <inheritdoc />
    public override string TypeText => "set_property";
}

/// <summary>Creates an item under a parent, with a templated title.</summary>
public sealed record CreateItemAction(AutomationItemReference Parent, string ItemType, string Title, JsonObject? Properties) : AutomationAction
{
    /// <inheritdoc />
    public override string TypeText => "create_item";
}

/// <summary>Sends the rule's owner an in-app (and push) notification.</summary>
public sealed record NotifyAction(string Title, string Body) : AutomationAction
{
    /// <inheritdoc />
    public override string TypeText => "notify";
}

/// <summary>Reads and writes a rule's action list.</summary>
public static class AutomationActionJson
{
    /// <summary>The most actions one rule may carry.</summary>
    public const int MaximumActions = 5;

    /// <summary>The longest a notification title template may be.</summary>
    public const int MaximumNotifyTitle = 200;

    /// <summary>The longest a notification body template may be.</summary>
    public const int MaximumNotifyBody = 1000;

    /// <summary>The longest a created item's title template may be.</summary>
    public const int MaximumItemTitle = 500;

    /// <summary>The largest a created item's property bag or a set value may be, in UTF-8 bytes.</summary>
    public const int MaximumValueBytes = 4096;

    /// <summary>
    /// The largest the whole action list may be, as this reader writes it, in UTF-8 bytes. The
    /// table stores it as <c>jsonb</c> bounded at 16,384 bytes of text, and <c>jsonb</c>'s text
    /// adds a space after every colon and comma - at most a third more for the densest object -
    /// so 12 KiB here stays inside that bound with the headroom it needs.
    /// </summary>
    public const int MaximumTotalBytes = 12_288;

    /// <summary>Reads an action list: one to five actions.</summary>
    public static AutomationParse<ImmutableArray<AutomationAction>> ReadAll(JsonNode? node)
    {
        var violations = new List<AutomationViolation>();
        if (node is not JsonArray array)
        {
            violations.Add(new AutomationViolation("actions", "must be a list"));
            return new AutomationParse<ImmutableArray<AutomationAction>>([], [.. violations]);
        }

        if (array.Count is 0 or > MaximumActions)
        {
            violations.Add(new AutomationViolation("actions", "must hold one to five actions"));
        }

        var actions = ImmutableArray.CreateBuilder<AutomationAction>(array.Count);
        for (var index = 0; index < array.Count; index++)
        {
            var path = $"actions[{index}]";
            if (array[index] is not JsonObject entry)
            {
                violations.Add(new AutomationViolation(path, "must be an object"));
                continue;
            }

            var before = violations.Count;
            var action = AutomationJsonRead.String(entry, "type", path, violations) switch
            {
                null => null,
                "set_property" => ReadSetProperty(entry, path, violations),
                "create_item" => ReadCreateItem(entry, path, violations),
                "notify" => ReadNotify(entry, path, violations),
                "create_from_template" => Unavailable(path, violations),
                _ => Unknown(path, violations),
            };
            if (violations.Count == before && action is not null)
            {
                actions.Add(action);
            }
        }

        return violations.Count == 0
            ? new AutomationParse<ImmutableArray<AutomationAction>>(actions.ToImmutable(), [])
            : new AutomationParse<ImmutableArray<AutomationAction>>([], [.. violations]);
    }

    /// <summary>Reads a stored action list that already passed <see cref="ReadAll"/>; throws if it no longer does.</summary>
    public static ImmutableArray<AutomationAction> ReadStored(string json)
    {
        var parsed = ReadAll(JsonNode.Parse(json));
        return parsed.IsValid ? parsed.Value : throw new InvalidOperationException("A stored automation action list no longer reads.");
    }

    /// <summary>Writes an action list in its stored shape.</summary>
    public static JsonArray WriteAll(IEnumerable<AutomationAction> actions)
    {
        ArgumentNullException.ThrowIfNull(actions);
        var array = new JsonArray();
        foreach (var action in actions)
        {
            var entry = new JsonObject { ["type"] = action.TypeText };
            switch (action)
            {
                case SetPropertyAction set:
                    entry["target"] = WriteReference(set.Target);
                    entry["key"] = set.Key;
                    entry["value"] = set.Value?.DeepClone();
                    break;
                case CreateItemAction create:
                    entry["parent"] = WriteReference(create.Parent);
                    entry["itemType"] = create.ItemType;
                    entry["title"] = create.Title;
                    if (create.Properties is not null)
                    {
                        entry["properties"] = create.Properties.DeepClone();
                    }

                    break;
                case NotifyAction notify:
                    entry["title"] = notify.Title;
                    entry["body"] = notify.Body;
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(actions), action.TypeText, "Unknown action.");
            }

            array.Add(entry);
        }

        return array;
    }

    private static SetPropertyAction? ReadSetProperty(JsonObject entry, string path, List<AutomationViolation> violations)
    {
        AutomationJsonRead.RefuseUnknown(entry, path, violations, "type", "target", "key", "value");
        var target = ReadReference(entry["target"], $"{path}.target", allowScope: false, violations);
        var key = AutomationJsonRead.String(entry, "key", path, violations);
        AutomationJsonRead.CheckKey(key, $"{path}.key", violations);
        if (!entry.ContainsKey("value"))
        {
            violations.Add(new AutomationViolation($"{path}.value", "is required; use null to clear the property"));
        }
        else if (AutomationJsonRead.Bytes(entry["value"]) > MaximumValueBytes)
        {
            violations.Add(new AutomationViolation($"{path}.value", "must be at most 4 KiB"));
        }

        return target is null || key is null ? null : new SetPropertyAction(target, key, entry["value"]?.DeepClone());
    }

    private static CreateItemAction? ReadCreateItem(JsonObject entry, string path, List<AutomationViolation> violations)
    {
        AutomationJsonRead.RefuseUnknown(entry, path, violations, "type", "parent", "itemType", "title", "properties");
        var parent = ReadReference(entry["parent"], $"{path}.parent", allowScope: true, violations);
        var itemType = AutomationJsonRead.String(entry, "itemType", path, violations);
        if (itemType is not null && (itemType.Length is 0 or > 64 || string.IsNullOrWhiteSpace(itemType) || itemType.Any(char.IsControl)))
        {
            violations.Add(new AutomationViolation($"{path}.itemType", "must be 1 to 64 characters"));
        }

        var title = AutomationJsonRead.String(entry, "title", path, violations);
        CheckTemplate(title, MaximumItemTitle, $"{path}.title", violations);

        JsonObject? properties = null;
        if (entry.TryGetPropertyValue("properties", out var bag) && bag is not null)
        {
            if (bag is not JsonObject bagObject)
            {
                violations.Add(new AutomationViolation($"{path}.properties", "must be an object"));
            }
            else
            {
                if (AutomationJsonRead.Bytes(bagObject) > MaximumValueBytes)
                {
                    violations.Add(new AutomationViolation($"{path}.properties", "must be at most 4 KiB"));
                }

                foreach (var member in bagObject)
                {
                    AutomationJsonRead.CheckKey(member.Key, $"{path}.properties.{member.Key}", violations);
                }

                properties = (JsonObject)bagObject.DeepClone();
            }
        }

        return parent is null || itemType is null || title is null ? null : new CreateItemAction(parent, itemType, title, properties);
    }

    private static NotifyAction? ReadNotify(JsonObject entry, string path, List<AutomationViolation> violations)
    {
        AutomationJsonRead.RefuseUnknown(entry, path, violations, "type", "title", "body");
        var title = AutomationJsonRead.String(entry, "title", path, violations);
        CheckTemplate(title, MaximumNotifyTitle, $"{path}.title", violations);
        var body = AutomationJsonRead.OptionalString(entry, "body", path, violations) ?? string.Empty;
        if (body.Length > MaximumNotifyBody)
        {
            violations.Add(new AutomationViolation($"{path}.body", "must be at most 1000 characters"));
        }

        return title is null ? null : new NotifyAction(title, body);
    }

    private static void CheckTemplate(string? template, int maximum, string path, List<AutomationViolation> violations)
    {
        if (template is not null && (string.IsNullOrWhiteSpace(template) || template.Length > maximum))
        {
            violations.Add(new AutomationViolation(path, $"must be 1 to {maximum} characters"));
        }
    }

    private static AutomationItemReference? ReadReference(JsonNode? node, string path, bool allowScope, List<AutomationViolation> violations)
    {
        switch (node)
        {
            case JsonValue value when value.TryGetValue<string>(out var text) && text == "triggering_item":
                return AutomationItemReference.Triggering;
            case JsonValue value when allowScope && value.TryGetValue<string>(out var text) && text == "scope":
                return AutomationItemReference.RuleScope;
            case JsonObject document when document.Count == 1
                && document["itemId"] is JsonValue id
                && id.TryGetValue<string>(out var idText)
                && Guid.TryParse(idText, out var itemId)
                && itemId != Guid.Empty:
                return new AutomationItemReference(AutomationItemReferenceKind.Item, itemId);
            default:
                violations.Add(new AutomationViolation(
                    path,
                    allowScope ? "must be \"triggering_item\", \"scope\" or {\"itemId\": ...}" : "must be \"triggering_item\" or {\"itemId\": ...}"));
                return null;
        }
    }

    private static JsonNode WriteReference(AutomationItemReference reference) => reference.Kind switch
    {
        AutomationItemReferenceKind.TriggeringItem => JsonValue.Create("triggering_item"),
        AutomationItemReferenceKind.Scope => JsonValue.Create("scope"),
        _ => new JsonObject { ["itemId"] = reference.ItemId!.Value.ToString("D") },
    };

    private static AutomationAction? Unavailable(string path, List<AutomationViolation> violations)
    {
        violations.Add(new AutomationViolation($"{path}.type", "create_from_template is not available yet", Unavailable: true));
        return null;
    }

    private static AutomationAction? Unknown(string path, List<AutomationViolation> violations)
    {
        violations.Add(new AutomationViolation($"{path}.type", "is not a known action"));
        return null;
    }
}
