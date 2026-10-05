using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Nix.Domain.Templates;

/// <summary>The versioned instructions used to initialize items from a template.</summary>
/// <param name="Version">The initialization format version.</param>
/// <param name="Inputs">The values requested from the person applying the template.</param>
/// <param name="Rules">The property rules applied to newly created items.</param>
/// <param name="References">The reference policy for each template body source.</param>
public sealed record TemplateInitialization(
    int Version,
    IReadOnlyList<TemplateInitializationInput> Inputs,
    IReadOnlyList<TemplateInitializationRule> Rules,
    IReadOnlyList<TemplateReferenceRule> References)
{
    /// <summary>An empty initialization definition for templates authored before this feature.</summary>
    public static TemplateInitialization Empty { get; } = new(1, [], [], []);
}

/// <summary>A value requested from the person applying a template.</summary>
/// <param name="Key">The stable key used by rules and <c>{{key}}</c> placeholders.</param>
/// <param name="Label">The label shown in the application form.</param>
/// <param name="Type">The value's kind.</param>
/// <param name="Required">Whether the application must supply or default this value.</param>
/// <param name="DefaultValue">An optional default, stored in the same wire form as a submitted value.</param>
public sealed record TemplateInitializationInput(
    string Key,
    string Label,
    TemplateInitializationInputType Type,
    bool Required,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DefaultValue = null);

/// <summary>The supported input kinds.</summary>
[JsonConverter(typeof(TemplateInitializationInputTypeConverter))]
public enum TemplateInitializationInputType
{
    /// <summary>Plain text.</summary>
    [JsonStringEnumMemberName("text")]
    Text,

    /// <summary>An ISO calendar day.</summary>
    [JsonStringEnumMemberName("date")]
    Date,

    /// <summary>A workspace member identifier.</summary>
    [JsonStringEnumMemberName("member")]
    Member,

    /// <summary>An ordinary readable item identifier.</summary>
    [JsonStringEnumMemberName("item")]
    Item,
}

/// <summary>How one property on one stable template item is initialized.</summary>
/// <param name="SourceId">The stable identity of the template item.</param>
/// <param name="PropertyKey">The declared property to initialize.</param>
/// <param name="Kind">The operation to perform.</param>
/// <param name="Value">The JSON value used by a <see cref="TemplateInitializationRuleKind.Set"/> rule.</param>
/// <param name="InputKey">The input used by an input or relative-date rule.</param>
/// <param name="OffsetDays">The signed day offset used by a relative-date rule.</param>
/// <param name="TimeOfDay">An optional local time for a timestamp relative-date rule, in <c>HH:mm</c> form.</param>
/// <param name="TimeZone">An optional IANA time-zone identifier for a timestamp relative-date rule.</param>
public sealed record TemplateInitializationRule(
    Guid SourceId,
    string PropertyKey,
    TemplateInitializationRuleKind Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonNode? Value = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? InputKey = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? OffsetDays = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TimeOfDay = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TimeZone = null)
{
    /// <summary>The rule target for the recurrence's inclusive final day.</summary>
    public const string RecurrenceUntilPropertyKey = "recurrence.until";
}

/// <summary>The supported property initialization operations.</summary>
[JsonConverter(typeof(TemplateInitializationRuleKindConverter))]
public enum TemplateInitializationRuleKind
{
    /// <summary>Retain the template's authored value, overriding the task reset defaults.</summary>
    [JsonStringEnumMemberName("keep")]
    Keep,

    /// <summary>Remove the authored property value.</summary>
    [JsonStringEnumMemberName("clear")]
    Clear,

    /// <summary>Set a literal JSON value.</summary>
    [JsonStringEnumMemberName("set")]
    Set,

    /// <summary>Set a value from a declared input.</summary>
    [JsonStringEnumMemberName("input")]
    Input,

    /// <summary>Set a date relative to a declared date input.</summary>
    [JsonStringEnumMemberName("relativeDate")]
    RelativeDate,
}

/// <summary>How body references from one template item are handled.</summary>
/// <param name="SourceItemId">The original external item target found in a template body.</param>
/// <param name="Policy">Whether references are retained, omitted, or replaced.</param>
/// <param name="InputKey">The item input used by a replacement policy.</param>
public sealed record TemplateReferenceRule(
    Guid SourceItemId,
    TemplateReferencePolicy Policy,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? InputKey = null);

/// <summary>The supported body reference policies.</summary>
[JsonConverter(typeof(TemplateReferencePolicyConverter))]
public enum TemplateReferencePolicy
{
    /// <summary>Keep the authored item target when it remains readable.</summary>
    [JsonStringEnumMemberName("retain")]
    Retain,

    /// <summary>Omit an authored external item reference.</summary>
    [JsonStringEnumMemberName("omit")]
    Omit,

    /// <summary>Replace an authored external item reference with an item input.</summary>
    [JsonStringEnumMemberName("replace")]
    Replace,
}

/// <summary>A resolved, validated set of initialization values.</summary>
/// <param name="Values">Canonical values used by property rules and reference replacement.</param>
/// <param name="TextBindings">Safe text values used only in text nodes and titles.</param>
public sealed record TemplateResolvedInputs(
    ImmutableDictionary<string, string> Values,
    ImmutableDictionary<string, string> TextBindings);

/// <summary>An item envelope read from a template before initialization.</summary>
/// <param name="SourceId">The stable identity of the template item.</param>
/// <param name="Title">The stored title.</param>
/// <param name="Properties">The stored JSON property bag.</param>
/// <param name="Recurrence">The stored recurrence rule, if present.</param>
public sealed record TemplateInitializationItem(
    Guid SourceId,
    string Title,
    string? Properties,
    string? Recurrence);

/// <summary>An item envelope after its initialization rules have been evaluated.</summary>
/// <param name="SourceId">The stable identity of the template item.</param>
/// <param name="Title">The title after safe placeholder substitution.</param>
/// <param name="Properties">The initialized JSON property bag.</param>
/// <param name="Recurrence">The recurrence with completion state reset.</param>
public sealed record TemplateInitializedItem(
    Guid SourceId,
    string Title,
    string? Properties,
    string? Recurrence);

/// <summary>The evaluated preview and authoritative binding data for an application.</summary>
/// <param name="Items">The initialized item envelopes.</param>
/// <param name="TextBindings">The safe text bindings for body materialization.</param>
/// <param name="References">The reference policies for body materialization.</param>
public sealed record TemplateInitializationResult(
    IReadOnlyList<TemplateInitializedItem> Items,
    IReadOnlyDictionary<string, string> TextBindings,
    IReadOnlyList<TemplateReferenceRule> References);

/// <summary>Reads and writes the versioned template initialization JSON.</summary>
public static class TemplateInitializationJson
{
    /// <summary>The maximum serialized initialization definition size.</summary>
    public const int MaximumBytes = 1024 * 1024;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Serializes a typed initialization definition.</summary>
    /// <param name="initialization">The definition.</param>
    /// <returns>Its canonical JSON representation.</returns>
    public static string Write(TemplateInitialization initialization)
    {
        ArgumentNullException.ThrowIfNull(initialization);
        return JsonSerializer.Serialize(initialization, Options);
    }

    /// <summary>Reads a stored initialization definition.</summary>
    /// <param name="json">The stored JSON, or null for a legacy template.</param>
    /// <param name="initialization">The parsed definition or the empty legacy definition.</param>
    /// <param name="refusal">A readable parse refusal, if the JSON is malformed.</param>
    /// <returns>True when the JSON was parsed.</returns>
    public static bool TryRead(
        string? json,
        out TemplateInitialization initialization,
        out string? refusal)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            initialization = TemplateInitialization.Empty;
            refusal = null;
            return true;
        }

        if (Encoding.UTF8.GetByteCount(json) > MaximumBytes)
        {
            initialization = TemplateInitialization.Empty;
            refusal = $"The template initialization definition exceeds {MaximumBytes} bytes.";
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            if (!TemplateInitializationValidator.HasRequiredShape(document.RootElement, out refusal))
            {
                initialization = TemplateInitialization.Empty;
                return false;
            }

            initialization = JsonSerializer.Deserialize<TemplateInitialization>(json, Options)
                ?? TemplateInitialization.Empty;
            refusal = null;
            return true;
        }
        catch (JsonException)
        {
            initialization = TemplateInitialization.Empty;
            refusal = "The template initialization definition is not valid versioned JSON.";
            return false;
        }
    }
}

/// <summary>Validates the versioned initialization definition and input values.</summary>
public static class TemplateInitializationValidator
{
    /// <summary>The maximum number of declared inputs.</summary>
    public const int MaximumInputs = 100;

    /// <summary>The maximum number of property and reference rules combined.</summary>
    public const int MaximumRules = 2000;

    /// <summary>The largest relative-date offset, in either direction.</summary>
    public const int MaximumOffsetDays = 36500;

    /// <summary>The maximum length of an input key.</summary>
    public const int MaximumKeyLength = 64;

    /// <summary>The maximum length of a text input value.</summary>
    public const int MaximumTextLength = 4096;

    /// <summary>Validates a definition against the stable item identifiers in its tree.</summary>
    /// <param name="initialization">The definition.</param>
    /// <param name="sourceIds">The identifiers in the template tree.</param>
    /// <returns>A refusal, or null when valid.</returns>
    public static string? Validate(
        TemplateInitialization initialization,
        IReadOnlySet<Guid> sourceIds)
    {
        ArgumentNullException.ThrowIfNull(initialization);
        ArgumentNullException.ThrowIfNull(sourceIds);

        if (initialization.Version != 1)
        {
            return "Only template initialization version 1 is supported.";
        }

        if (initialization.Inputs is null || initialization.Rules is null || initialization.References is null)
        {
            return "Initialization inputs, rules, and references must be arrays.";
        }

        if (initialization.Inputs.Count > MaximumInputs)
        {
            return $"A template may declare at most {MaximumInputs} initialization inputs.";
        }

        if (initialization.Rules.Count + initialization.References.Count > MaximumRules)
        {
            return $"A template may declare at most {MaximumRules} initialization rules.";
        }

        var inputs = new Dictionary<string, TemplateInitializationInput>(StringComparer.Ordinal);
        foreach (var input in initialization.Inputs)
        {
            if (input is null)
            {
                return "Initialization inputs cannot contain null entries.";
            }

            if (!IsKey(input.Key) || !inputs.TryAdd(input.Key, input))
            {
                return $"Initialization input key '{input.Key}' is invalid or duplicated.";
            }

            if (string.IsNullOrWhiteSpace(input.Label) || input.Label.Length > 120)
            {
                return $"Initialization input '{input.Key}' needs a label of 1 to 120 characters.";
            }

            if (!Enum.IsDefined(input.Type))
            {
                return $"Initialization input '{input.Key}' has an unsupported type.";
            }

            if (input.DefaultValue is { } defaultValue
                && ValidateInputValue(input, defaultValue) is { } defaultRefusal)
            {
                return $"Initialization input '{input.Key}' has an invalid default: {defaultRefusal}";
            }
        }

        var seenRules = new HashSet<(Guid SourceId, string PropertyKey)>();
        foreach (var rule in initialization.Rules)
        {
            if (rule is null)
            {
                return "Initialization rules cannot contain null entries.";
            }

            if (rule.SourceId == Guid.Empty || !sourceIds.Contains(rule.SourceId))
            {
                return $"Initialization rule source '{rule.SourceId}' is not in the template tree.";
            }

            if (string.IsNullOrWhiteSpace(rule.PropertyKey) || rule.PropertyKey.Length > 160)
            {
                return "Every initialization rule needs a property key of 1 to 160 characters.";
            }

            if (!seenRules.Add((rule.SourceId, rule.PropertyKey)))
            {
                return $"Property '{rule.PropertyKey}' on template item '{rule.SourceId}' has more than one initialization rule.";
            }

            if (!Enum.IsDefined(rule.Kind))
            {
                return $"Property '{rule.PropertyKey}' has an unsupported initialization rule.";
            }

            var reason = ValidateRule(rule, inputs);
            if (reason is not null)
            {
                return reason;
            }
        }

        var seenReferences = new HashSet<Guid>();
        foreach (var reference in initialization.References)
        {
            if (reference is null)
            {
                return "Reference policies cannot contain null entries.";
            }

            if (reference.SourceItemId == Guid.Empty)
            {
                return "A reference policy needs a non-empty original target identifier.";
            }

            if (!seenReferences.Add(reference.SourceItemId))
            {
                return $"External item '{reference.SourceItemId}' has more than one reference policy.";
            }

            if (!Enum.IsDefined(reference.Policy))
            {
                return $"External item '{reference.SourceItemId}' has an unsupported reference policy.";
            }

            if (reference.Policy == TemplateReferencePolicy.Replace)
            {
                if (reference.InputKey is null
                    || !inputs.TryGetValue(reference.InputKey, out var input)
                    || input.Type != TemplateInitializationInputType.Item)
                {
                    return $"Replacement reference '{reference.SourceItemId}' must use an item input.";
                }
            }
            else if (reference.InputKey is not null)
            {
                return $"Reference policy '{reference.Policy}' does not accept an input key.";
            }
        }

        return null;
    }

    /// <summary>Validates and canonicalizes application input values.</summary>
    /// <param name="initialization">The template definition.</param>
    /// <param name="supplied">Values submitted by the caller.</param>
    /// <param name="displayValues">Authoritative display names for member and item IDs.</param>
    /// <param name="resolved">Canonical values and safe text bindings.</param>
    /// <param name="refusal">A readable refusal, if values are invalid.</param>
    /// <returns>True when all inputs resolve.</returns>
    public static bool TryResolveInputs(
        TemplateInitialization initialization,
        IReadOnlyDictionary<string, string>? supplied,
        IReadOnlyDictionary<string, string>? displayValues,
        out TemplateResolvedInputs resolved,
        out string? refusal)
    {
        ArgumentNullException.ThrowIfNull(initialization);

        supplied ??= ImmutableDictionary<string, string>.Empty;
        displayValues ??= ImmutableDictionary<string, string>.Empty;
        if (initialization.Inputs is null)
        {
            resolved = EmptyInputs;
            refusal = "Initialization inputs must be an array.";
            return false;
        }

        if (initialization.Inputs.Any(input => input is null)
            || initialization.Inputs.Select(input => input.Key).Distinct(StringComparer.Ordinal).Count() != initialization.Inputs.Count)
        {
            resolved = EmptyInputs;
            refusal = "Initialization inputs must have non-null, unique keys.";
            return false;
        }

        var declared = initialization.Inputs.ToDictionary(input => input.Key, StringComparer.Ordinal);
        foreach (var key in supplied.Keys)
        {
            if (!declared.ContainsKey(key))
            {
                resolved = EmptyInputs;
                refusal = $"Initialization input '{key}' is not declared by this template.";
                return false;
            }
        }

        var values = ImmutableDictionary.CreateBuilder<string, string>(StringComparer.Ordinal);
        var textBindings = ImmutableDictionary.CreateBuilder<string, string>(StringComparer.Ordinal);
        foreach (var input in initialization.Inputs)
        {
            var hasSubmitted = supplied.TryGetValue(input.Key, out var submitted);
            var explicitClear = hasSubmitted && submitted is { Length: 0 } && !input.Required;
            var value = explicitClear
                ? null
                : hasSubmitted ? submitted : input.DefaultValue;
            if (explicitClear)
            {
                textBindings[input.Key] = string.Empty;
                continue;
            }

            if (value is null)
            {
                if (input.Required)
                {
                    resolved = EmptyInputs;
                    refusal = $"Initialization input '{input.Key}' is required.";
                    return false;
                }

                textBindings[input.Key] = string.Empty;
                continue;
            }

            if (input.Required && string.IsNullOrWhiteSpace(value))
            {
                resolved = EmptyInputs;
                refusal = $"Initialization input '{input.Key}' is required.";
                return false;
            }

            if (ValidateInputValue(input, value) is { } reason)
            {
                resolved = EmptyInputs;
                refusal = $"Initialization input '{input.Key}' {reason}";
                return false;
            }

            var canonical = CanonicalInputValue(input.Type, value);
            values[input.Key] = canonical;
            if (input.Type is TemplateInitializationInputType.Member or TemplateInitializationInputType.Item)
            {
                if (!displayValues.TryGetValue(input.Key, out var displayValue)
                    || string.IsNullOrWhiteSpace(displayValue)
                    || displayValue.Length > MaximumTextLength)
                {
                    resolved = EmptyInputs;
                    refusal = $"Initialization input '{input.Key}' does not resolve to a readable workspace item or member.";
                    return false;
                }

                textBindings[input.Key] = displayValue;
            }
            else
            {
                textBindings[input.Key] = canonical;
            }
        }

        resolved = new TemplateResolvedInputs(values.ToImmutable(), textBindings.ToImmutable());
        refusal = null;
        return true;
    }

    /// <summary>Checks whether a key can be used as an input and placeholder name.</summary>
    /// <param name="key">The candidate key.</param>
    /// <returns>True when the key is a bounded ASCII identifier.</returns>
    public static bool IsKey(string? key)
    {
        if (string.IsNullOrEmpty(key)
            || key.Length > MaximumKeyLength
            || key[0] is < 'a' or > 'z')
        {
            return false;
        }

        for (var index = 1; index < key.Length; index++)
        {
            var character = key[index];
            if (character is not (>= 'a' and <= 'z')
                && !char.IsAsciiDigit(character)
                && character != '_'
                && character != '-')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Checks one input value against its declared scalar format.</summary>
    /// <param name="input">The declaration.</param>
    /// <param name="value">The submitted or default value.</param>
    /// <returns>A refusal, or null when valid.</returns>
    public static string? ValidateInputValue(TemplateInitializationInput input, string value)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(value);

        return input.Type switch
        {
            TemplateInitializationInputType.Text => value.Length <= MaximumTextLength
                ? null
                : $"must be at most {MaximumTextLength} characters.",
            TemplateInitializationInputType.Date => DateOnly.TryParseExact(
                value,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out _)
                    ? null
                    : "must be an ISO calendar day in yyyy-MM-dd form.",
            TemplateInitializationInputType.Member or TemplateInitializationInputType.Item => Guid.TryParseExact(
                value,
                "D",
                out _)
                    ? null
                    : "must be a UUID.",
            _ => "has an unsupported type.",
        };
    }

    private static TemplateResolvedInputs EmptyInputs { get; } = new(
        ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal),
        ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal));

    private static string? ValidateRule(
        TemplateInitializationRule rule,
        Dictionary<string, TemplateInitializationInput> inputs)
    {
        switch (rule.Kind)
        {
            case TemplateInitializationRuleKind.Keep:
            case TemplateInitializationRuleKind.Clear:
                return rule.Value is null && rule.InputKey is null && rule.OffsetDays is null
                    && rule.TimeOfDay is null && rule.TimeZone is null
                    ? null
                    : $"Rule '{rule.Kind}' for '{rule.PropertyKey}' does not accept a value or input.";

            case TemplateInitializationRuleKind.Set:
                if (rule.PropertyKey == TemplateInitializationRule.RecurrenceUntilPropertyKey)
                {
                    return rule.Value is JsonValue dateNode
                        && dateNode.TryGetValue(out string? dateText)
                        && TemplateInitializationValidator.ValidateInputValue(
                            new TemplateInitializationInput("date", "Date", TemplateInitializationInputType.Date, false),
                            dateText) is null
                        && rule.InputKey is null && rule.OffsetDays is null
                        && rule.TimeOfDay is null && rule.TimeZone is null
                            ? null
                            : "Rule 'set' for 'recurrence.until' needs an ISO calendar day value.";
                }

                return rule.Value is not null && rule.InputKey is null && rule.OffsetDays is null
                    && rule.TimeOfDay is null && rule.TimeZone is null
                    ? null
                    : $"Rule 'set' for '{rule.PropertyKey}' needs only a JSON value.";

            case TemplateInitializationRuleKind.Input:
                if (rule.PropertyKey == TemplateInitializationRule.RecurrenceUntilPropertyKey)
                {
                    return rule.Value is null && rule.InputKey is { } untilInputKey
                        && inputs.TryGetValue(untilInputKey, out var untilInput)
                        && untilInput.Type == TemplateInitializationInputType.Date
                        && rule.OffsetDays is null && rule.TimeOfDay is null && rule.TimeZone is null
                            ? null
                            : "Rule 'input' for 'recurrence.until' needs a date input key.";
                }

                return rule.Value is null && rule.InputKey is { } inputKey && inputs.ContainsKey(inputKey)
                    && rule.OffsetDays is null && rule.TimeOfDay is null && rule.TimeZone is null
                    ? null
                    : $"Rule 'input' for '{rule.PropertyKey}' needs a declared input key.";

            case TemplateInitializationRuleKind.RelativeDate:
                if (rule.Value is not null || rule.InputKey is null || rule.OffsetDays is null
                    || rule.OffsetDays is < -MaximumOffsetDays or > MaximumOffsetDays
                    || !inputs.TryGetValue(rule.InputKey, out var input)
                    || input.Type != TemplateInitializationInputType.Date)
                {
                    return $"Rule 'relativeDate' for '{rule.PropertyKey}' needs a date input and day offset.";
                }

                if (rule.PropertyKey == TemplateInitializationRule.RecurrenceUntilPropertyKey)
                {
                    return rule.TimeOfDay is null && rule.TimeZone is null
                        ? null
                        : "Rule 'relativeDate' for 'recurrence.until' accepts no time or time zone.";
                }

                if (rule.TimeOfDay is null != (rule.TimeZone is null))
                {
                    return $"A relative timestamp rule for '{rule.PropertyKey}' needs both a local time and a time zone.";
                }

                return rule.TimeOfDay is { } time && (time.Length != 5
                    || !char.IsAsciiDigit(time[0]) || !char.IsAsciiDigit(time[1]) || time[2] != ':'
                    || !char.IsAsciiDigit(time[3]) || !char.IsAsciiDigit(time[4]))
                    ? $"Relative timestamp rule for '{rule.PropertyKey}' needs a local time in HH:mm form."
                    : null;

            default:
                return $"Rule for '{rule.PropertyKey}' has an unsupported operation.";
        }
    }

    /// <summary>Returns the stable wire form for an already validated input value.</summary>
    /// <param name="type">The declared input kind.</param>
    /// <param name="value">The validated input value.</param>
    /// <returns>A canonical identifier for member/item inputs; otherwise the original scalar.</returns>
    public static string CanonicalInputValue(TemplateInitializationInputType type, string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return type switch
        {
            TemplateInitializationInputType.Member or TemplateInitializationInputType.Item
                => Guid.ParseExact(value, "D").ToString("D"),
            _ => value,
        };
    }

    internal static bool HasRequiredShape(JsonElement root, out string? refusal)
    {
        if (root.ValueKind != JsonValueKind.Object
            || !HasOnlyProperties(root, "version", "inputs", "rules", "references")
            || !root.TryGetProperty("version", out var version)
            || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out _)
            || !root.TryGetProperty("inputs", out var inputs)
            || inputs.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("rules", out var rules)
            || rules.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("references", out var references)
            || references.ValueKind != JsonValueKind.Array)
        {
            refusal = "The template initialization definition must contain an integer version and input, rule, and reference arrays.";
            return false;
        }

        if (inputs.GetArrayLength() > MaximumInputs
            || rules.GetArrayLength() + references.GetArrayLength() > MaximumRules)
        {
            refusal = "The template initialization definition exceeds its input or rule limit.";
            return false;
        }

        foreach (var input in inputs.EnumerateArray())
        {
            if (input.ValueKind != JsonValueKind.Object
                || !HasOnlyProperties(input, "key", "label", "type", "required", "defaultValue")
                || !HasString(input, "key")
                || !HasString(input, "label")
                || !HasString(input, "type")
                || !input.TryGetProperty("required", out var required)
                || required.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                || (input.TryGetProperty("defaultValue", out var defaultValue)
                    && defaultValue.ValueKind != JsonValueKind.String))
            {
                refusal = "Every initialization input must contain a string key, label, type, and boolean required flag.";
                return false;
            }
        }

        foreach (var rule in rules.EnumerateArray())
        {
            if (rule.ValueKind != JsonValueKind.Object
                || !HasOnlyProperties(rule, "sourceId", "propertyKey", "kind", "value", "inputKey", "offsetDays", "timeOfDay", "timeZone")
                || !HasUuid(rule, "sourceId")
                || !HasString(rule, "propertyKey")
                || !HasString(rule, "kind")
                || (rule.TryGetProperty("inputKey", out var inputKey) && inputKey.ValueKind != JsonValueKind.String)
                || (rule.TryGetProperty("timeOfDay", out var time) && time.ValueKind != JsonValueKind.String)
                || (rule.TryGetProperty("timeZone", out var zone) && zone.ValueKind != JsonValueKind.String)
                || (rule.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Null)
                || (rule.TryGetProperty("offsetDays", out var offset)
                    && (offset.ValueKind != JsonValueKind.Number || !offset.TryGetInt32(out _))))
            {
                refusal = "Every initialization rule must contain a UUID source, string property key, string kind, and correctly typed optional fields.";
                return false;
            }
        }

        foreach (var reference in references.EnumerateArray())
        {
            if (reference.ValueKind != JsonValueKind.Object
                || !HasOnlyProperties(reference, "sourceItemId", "policy", "inputKey")
                || !HasUuid(reference, "sourceItemId")
                || !HasString(reference, "policy")
                || (reference.TryGetProperty("inputKey", out var inputKey)
                    && inputKey.ValueKind != JsonValueKind.String))
            {
                refusal = "Every reference policy must contain a UUID target, string policy, and optional string input key.";
                return false;
            }
        }

        refusal = null;
        return true;
    }

    private static bool HasOnlyProperties(JsonElement element, params string[] allowed)
    {
        var names = allowed.ToHashSet(StringComparer.Ordinal);
        var observed = new HashSet<string>(StringComparer.Ordinal);
        return element.EnumerateObject().All(property => names.Contains(property.Name) && observed.Add(property.Name));
    }

    private static bool HasString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String;

    private static bool HasUuid(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
        && Guid.TryParseExact(value.GetString(), "D", out _);
}

[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "System.Text.Json creates the converter through JsonConverterAttribute.")]
internal sealed class TemplateInitializationInputTypeConverter : JsonConverter<TemplateInitializationInputType>
{
    public override TemplateInitializationInputType Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? reader.GetString() switch
        {
            "text" => TemplateInitializationInputType.Text,
            "date" => TemplateInitializationInputType.Date,
            "member" => TemplateInitializationInputType.Member,
            "item" => TemplateInitializationInputType.Item,
            _ => throw new JsonException("Unknown template input type."),
        } : throw new JsonException("Template input types must be strings.");

    public override void Write(Utf8JsonWriter writer, TemplateInitializationInputType value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value switch
        {
            TemplateInitializationInputType.Text => "text",
            TemplateInitializationInputType.Date => "date",
            TemplateInitializationInputType.Member => "member",
            TemplateInitializationInputType.Item => "item",
            _ => throw new JsonException("Unknown template input type."),
        });
}

[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "System.Text.Json creates the converter through JsonConverterAttribute.")]
internal sealed class TemplateInitializationRuleKindConverter : JsonConverter<TemplateInitializationRuleKind>
{
    public override TemplateInitializationRuleKind Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? reader.GetString() switch
        {
            "keep" => TemplateInitializationRuleKind.Keep,
            "clear" => TemplateInitializationRuleKind.Clear,
            "set" => TemplateInitializationRuleKind.Set,
            "input" => TemplateInitializationRuleKind.Input,
            "relativeDate" => TemplateInitializationRuleKind.RelativeDate,
            _ => throw new JsonException("Unknown template initialization rule kind."),
        } : throw new JsonException("Template initialization rule kinds must be strings.");

    public override void Write(Utf8JsonWriter writer, TemplateInitializationRuleKind value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value switch
        {
            TemplateInitializationRuleKind.Keep => "keep",
            TemplateInitializationRuleKind.Clear => "clear",
            TemplateInitializationRuleKind.Set => "set",
            TemplateInitializationRuleKind.Input => "input",
            TemplateInitializationRuleKind.RelativeDate => "relativeDate",
            _ => throw new JsonException("Unknown template initialization rule kind."),
        });
}

[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "System.Text.Json creates the converter through JsonConverterAttribute.")]
internal sealed class TemplateReferencePolicyConverter : JsonConverter<TemplateReferencePolicy>
{
    public override TemplateReferencePolicy Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? reader.GetString() switch
        {
            "retain" => TemplateReferencePolicy.Retain,
            "omit" => TemplateReferencePolicy.Omit,
            "replace" => TemplateReferencePolicy.Replace,
            _ => throw new JsonException("Unknown template reference policy."),
        } : throw new JsonException("Template reference policies must be strings.");

    public override void Write(Utf8JsonWriter writer, TemplateReferencePolicy value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value switch
        {
            TemplateReferencePolicy.Retain => "retain",
            TemplateReferencePolicy.Omit => "omit",
            TemplateReferencePolicy.Replace => "replace",
            _ => throw new JsonException("Unknown template reference policy."),
        });
}
