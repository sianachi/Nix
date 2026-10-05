using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Domain.Properties;
using Nix.Domain.Recurrence;
using NodaTime;
using NodaTime.Text;

namespace Nix.Domain.Templates;

/// <summary>Evaluates versioned template initialization without writing to a workspace.</summary>
public static class TemplateInitializationEvaluator
{
    private const string PlaceholderOpen = "{{";
    private const string PlaceholderClose = "}}";

    /// <summary>Evaluates task resets, property rules, title bindings, and recurrence anchors.</summary>
    /// <param name="initialization">The definition, or null for a legacy template.</param>
    /// <param name="items">The active template tree in parent-first order.</param>
    /// <param name="inputs">Canonical inputs already validated by the caller.</param>
    /// <param name="effectiveSchemas">The effective property schema for each source item.</param>
    /// <param name="result">The evaluated tree and body binding data.</param>
    /// <param name="refusal">A readable refusal, if an input or rule cannot be applied.</param>
    /// <returns>True when the full template tree can be initialized.</returns>
    public static bool TryEvaluate(
        TemplateInitialization? initialization,
        IReadOnlyList<TemplateInitializationItem> items,
        TemplateResolvedInputs inputs,
        IReadOnlyDictionary<Guid, PropertySchema> effectiveSchemas,
        out TemplateInitializationResult result,
        out string? refusal,
        IReadOnlySet<Guid>? completeSourceIds = null)
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(effectiveSchemas);

        var definition = initialization ?? TemplateInitialization.Empty;
        var sourceIds = items.Select(item => item.SourceId).ToHashSet();
        if (sourceIds.Count != items.Count)
        {
            result = EmptyResult(inputs.TextBindings, definition.References);
            refusal = "The template tree has duplicate stable source identifiers.";
            return false;
        }

        if (TemplateInitializationValidator.Validate(definition, completeSourceIds ?? sourceIds) is { } invalidDefinition)
        {
            result = EmptyResult(inputs.TextBindings, definition.References);
            refusal = invalidDefinition;
            return false;
        }

        var inputDefinitions = definition.Inputs.ToDictionary(input => input.Key, StringComparer.Ordinal);
        var rules = definition.Rules.ToDictionary(
            rule => (rule.SourceId, rule.PropertyKey),
            rule => rule);
        var evaluated = new List<TemplateInitializedItem>(items.Count);
        foreach (var item in items)
        {
            var schema = effectiveSchemas.TryGetValue(item.SourceId, out var foundSchema)
                ? foundSchema
                : PropertySchema.Empty;
            if (!TryReadBag(item.Properties, out var original, out var bagRefusal))
            {
                result = EmptyResult(inputs.TextBindings, definition.References);
                refusal = $"Template item '{item.SourceId}' has {bagRefusal}";
                return false;
            }

            var properties = (JsonObject)original.DeepClone();
            foreach (var property in schema.Properties)
            {
                if (rules.TryGetValue((item.SourceId, property.Key), out var explicitRule)
                    && explicitRule.Kind == TemplateInitializationRuleKind.Keep)
                {
                    continue;
                }

                switch (property.Type)
                {
                    case PropertyType.Completion:
                        properties[property.Key] = false;
                        break;
                    case PropertyType.Assignee:
                    case PropertyType.DueDate:
                    case PropertyType.StartDate:
                        properties.Remove(property.Key);
                        break;
                }
            }

            foreach (var rule in definition.Rules.Where(rule => rule.SourceId == item.SourceId))
            {
                if (rule.PropertyKey == TemplateInitializationRule.RecurrenceUntilPropertyKey)
                {
                    continue;
                }

                var property = schema.Find(rule.PropertyKey);
                if (property is null)
                {
                    result = EmptyResult(inputs.TextBindings, definition.References);
                    refusal = $"Initialization rule property '{rule.PropertyKey}' is not declared on template item '{item.SourceId}'.";
                    return false;
                }

                switch (rule.Kind)
                {
                    case TemplateInitializationRuleKind.Keep:
                        if (original.TryGetPropertyValue(rule.PropertyKey, out var retained))
                        {
                            properties[rule.PropertyKey] = retained?.DeepClone();
                        }
                        else
                        {
                            properties.Remove(rule.PropertyKey);
                        }

                        break;

                    case TemplateInitializationRuleKind.Clear:
                        properties.Remove(rule.PropertyKey);
                        break;

                    case TemplateInitializationRuleKind.Set:
                        properties[rule.PropertyKey] = rule.Value?.DeepClone();
                        break;

                    case TemplateInitializationRuleKind.Input:
                        if (!inputs.Values.TryGetValue(rule.InputKey!, out var inputValue))
                        {
                            properties.Remove(rule.PropertyKey);
                            break;
                        }

                        string? inputRefusal = null;
                        if (!inputDefinitions.TryGetValue(rule.InputKey!, out var inputDefinition)
                            || !TryInputNode(inputDefinition, property, inputValue, out var inputNode, out inputRefusal))
                        {
                            result = EmptyResult(inputs.TextBindings, definition.References);
                            refusal = inputRefusal
                                ?? $"Initialization input '{rule.InputKey}' is missing or incompatible with property '{rule.PropertyKey}'.";
                            return false;
                        }

                        properties[rule.PropertyKey] = inputNode;
                        break;

                    case TemplateInitializationRuleKind.RelativeDate:
                        if (!inputs.Values.TryGetValue(rule.InputKey!, out var dateText))
                        {
                            properties.Remove(rule.PropertyKey);
                            break;
                        }

                        string? relativeRefusal = null;
                        if (!DateOnly.TryParseExact(
                                dateText,
                                "yyyy-MM-dd",
                                CultureInfo.InvariantCulture,
                                DateTimeStyles.None,
                                out var baseDate)
                            || !TryRelativeDate(
                                baseDate,
                                rule.OffsetDays!.Value,
                                property.Type,
                                rule.TimeOfDay,
                                rule.TimeZone,
                                out var relativeValue,
                                out relativeRefusal))
                        {
                            result = EmptyResult(inputs.TextBindings, definition.References);
                            refusal = relativeRefusal
                                ?? $"Relative date rule for '{rule.PropertyKey}' has no valid date input.";
                            return false;
                        }

                        properties[rule.PropertyKey] = JsonValue.Create(relativeValue);
                        break;
                }
            }

            var violations = PropertyValidator.ValidateSupplied(properties.ToJsonString(), schema);
            if (!violations.IsEmpty)
            {
                result = EmptyResult(inputs.TextBindings, definition.References);
                refusal = $"Initialization makes template item '{item.SourceId}' invalid: "
                    + string.Join(" ", violations.Select(violation =>
                        string.IsNullOrEmpty(violation.Key) ? violation.Reason : $"{violation.Key}: {violation.Reason}"));
                return false;
            }

            foreach (var requiredProperty in schema.Properties.Where(property => property.Required))
            {
                if (!properties.TryGetPropertyValue(requiredProperty.Key, out var requiredValue)
                    || IsRequiredValueEmpty(requiredValue))
                {
                    result = EmptyResult(inputs.TextBindings, definition.References);
                    refusal = $"Initialization leaves required property '{requiredProperty.Key}' empty on template item '{item.SourceId}'.";
                    return false;
                }
            }

            if (!TryBindText(item.Title, inputs.TextBindings, out var title, out var titleRefusal))
            {
                result = EmptyResult(inputs.TextBindings, definition.References);
                refusal = $"Template item '{item.SourceId}' title {titleRefusal}";
                return false;
            }

            if (string.IsNullOrWhiteSpace(title) || title.Length > 200)
            {
                result = EmptyResult(inputs.TextBindings, definition.References);
                refusal = $"Template item '{item.SourceId}' has a blank title or a title over 200 characters after binding.";
                return false;
            }

            var untilRule = rules.GetValueOrDefault((item.SourceId, TemplateInitializationRule.RecurrenceUntilPropertyKey));
            if (!TryResetRecurrence(
                    item.Recurrence,
                    properties,
                    schema,
                    item.SourceId,
                    untilRule,
                    inputs.Values,
                    out var recurrence,
                    out var recurrenceRefusal))
            {
                result = EmptyResult(inputs.TextBindings, definition.References);
                refusal = recurrenceRefusal;
                return false;
            }

            evaluated.Add(new TemplateInitializedItem(
                item.SourceId,
                title,
                properties.Count == 0 ? null : properties.ToJsonString(),
                recurrence));
        }

        result = new TemplateInitializationResult(evaluated, inputs.TextBindings, definition.References);
        refusal = null;
        return true;
    }

    /// <summary>Substitutes only declared text placeholders, rejecting unknown or malformed markers.</summary>
    /// <param name="source">The title or text value to bind.</param>
    /// <param name="bindings">The validated, display-safe values.</param>
    /// <param name="bound">The substituted value.</param>
    /// <param name="refusal">A readable refusal when a marker is malformed or unknown.</param>
    /// <returns>True when the source can be bound.</returns>
    public static bool TryBindText(
        string source,
        IReadOnlyDictionary<string, string> bindings,
        out string bound,
        out string? refusal)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(bindings);

        var output = new System.Text.StringBuilder(source.Length);
        var cursor = 0;
        while (cursor < source.Length)
        {
            var open = source.IndexOf(PlaceholderOpen, cursor, StringComparison.Ordinal);
            var closeWithoutOpen = source.IndexOf(PlaceholderClose, cursor, StringComparison.Ordinal);
            if (closeWithoutOpen >= 0 && (open < 0 || closeWithoutOpen < open))
            {
                bound = string.Empty;
                refusal = "contains an unmatched '}}' marker.";
                return false;
            }

            if (open < 0)
            {
                output.Append(source, cursor, source.Length - cursor);
                break;
            }

            output.Append(source, cursor, open - cursor);
            var close = source.IndexOf(PlaceholderClose, open + PlaceholderOpen.Length, StringComparison.Ordinal);
            if (close < 0)
            {
                bound = string.Empty;
                refusal = "contains an unclosed '{{' marker.";
                return false;
            }

            var key = source[(open + PlaceholderOpen.Length)..close];
            if (!TemplateInitializationValidator.IsKey(key))
            {
                bound = string.Empty;
                refusal = "contains a placeholder with an invalid input key.";
                return false;
            }

            if (!bindings.TryGetValue(key, out var value))
            {
                bound = string.Empty;
                refusal = $"uses undeclared input '{key}'.";
                return false;
            }

            output.Append(value);
            cursor = close + PlaceholderClose.Length;
        }

        bound = output.ToString();
        refusal = null;
        return true;
    }

    /// <summary>Reads valid placeholder keys from a title without resolving their values.</summary>
    /// <param name="source">The title text.</param>
    /// <returns>The valid keys referenced by the title.</returns>
    public static IReadOnlySet<string> ReadTextBindingKeys(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        var keys = new HashSet<string>(StringComparer.Ordinal);
        var cursor = 0;
        while (cursor < source.Length)
        {
            var open = source.IndexOf(PlaceholderOpen, cursor, StringComparison.Ordinal);
            if (open < 0)
            {
                break;
            }

            var close = source.IndexOf(PlaceholderClose, open + PlaceholderOpen.Length, StringComparison.Ordinal);
            if (close < 0)
            {
                break;
            }

            var key = source[(open + PlaceholderOpen.Length)..close];
            if (TemplateInitializationValidator.IsKey(key))
            {
                keys.Add(key);
            }

            cursor = close + PlaceholderClose.Length;
        }

        return keys;
    }

    private static bool TryInputNode(
        TemplateInitializationInput input,
        PropertyDefinition property,
        string value,
        out JsonNode? node,
        out string? refusal)
    {
        var compatible = input.Type switch
        {
            TemplateInitializationInputType.Text => property.Type == PropertyType.Text,
            TemplateInitializationInputType.Date => property.Type is PropertyType.Date or PropertyType.DueDate or PropertyType.StartDate,
            TemplateInitializationInputType.Member => property.Type == PropertyType.Assignee,
            TemplateInitializationInputType.Item => false,
            _ => false,
        };

        if (!compatible)
        {
            node = null;
            refusal = $"Initialization input '{input.Key}' is incompatible with property '{property.Key}'.";
            return false;
        }

        node = JsonValue.Create(value);
        refusal = null;
        return true;
    }

    private static bool TryRelativeDate(
        DateOnly baseDate,
        int offsetDays,
        PropertyType targetType,
        string? timeOfDay,
        string? timeZone,
        out string value,
        out string? refusal)
    {
        DateOnly targetDate;
        try
        {
            targetDate = baseDate.AddDays(offsetDays);
        }
        catch (ArgumentOutOfRangeException)
        {
            value = string.Empty;
            refusal = "The relative date falls outside the supported calendar range.";
            return false;
        }

        if (targetType is PropertyType.Date or PropertyType.DueDate or PropertyType.StartDate)
        {
            value = targetDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            refusal = null;
            return timeOfDay is null && timeZone is null;
        }

        if (targetType != PropertyType.Timestamp || timeOfDay is null || timeZone is null)
        {
            value = string.Empty;
            refusal = "A relative date can target only a date property, or a timestamp with an explicit local time and time zone.";
            return false;
        }

        var timeResult = LocalTimePattern.CreateWithInvariantCulture("HH:mm").Parse(timeOfDay);
        var zone = DateTimeZoneProviders.Tzdb.GetZoneOrNull(timeZone);
        if (!timeResult.Success || zone is null)
        {
            value = string.Empty;
            refusal = "A relative timestamp needs a valid HH:mm local time and IANA time zone.";
            return false;
        }

        var local = new LocalDate(targetDate.Year, targetDate.Month, targetDate.Day).At(timeResult.Value);
        var mapping = zone.MapLocal(local);
        if (mapping.Count != 1)
        {
            value = string.Empty;
            refusal = mapping.Count == 0
                ? "The relative timestamp falls in a daylight-saving gap. Choose a different local time."
                : "The relative timestamp is ambiguous because of a daylight-saving transition. Choose a different local time.";
            return false;
        }

        var instant = mapping.Single().ToInstant();
        var offsetDateTime = new OffsetDateTime(local, zone.GetUtcOffset(instant));
        value = $"{OffsetDateTimePattern.Rfc3339.Format(offsetDateTime)}[{timeZone}]";
        refusal = null;
        return true;
    }

    private static bool IsRequiredValueEmpty(JsonNode? value) => value switch
    {
        null => true,
        JsonArray array => array.Count == 0,
        JsonValue scalar when scalar.TryGetValue(out string? text) => string.IsNullOrWhiteSpace(text),
        _ => false,
    };

    private static bool TryResetRecurrence(
        string? sourceRecurrence,
        JsonObject properties,
        PropertySchema schema,
        Guid sourceId,
        TemplateInitializationRule? untilRule,
        ImmutableDictionary<string, string> inputValues,
        out string? recurrence,
        out string? refusal)
    {
        if (sourceRecurrence is null)
        {
            recurrence = null;
            refusal = untilRule is null
                ? null
                : $"Template item '{sourceId}' has a recurrence-until rule but no recurring series.";
            return untilRule is null;
        }

        var rule = RecurrenceRuleJson.Read(sourceRecurrence);
        if (rule is null)
        {
            recurrence = null;
            refusal = $"Recurring template item '{sourceId}' has a rule that this build cannot interpret.";
            return false;
        }

        var dueProperty = schema.Properties.FirstOrDefault(property => property.Type == PropertyType.DueDate);
        var anchorKey = dueProperty?.Key ?? "due_date";
        if (properties[anchorKey] is not JsonValue dueValue
            || !dueValue.TryGetValue(out string? dueText)
            || !DateOnly.TryParseExact(
                dueText,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var anchor))
        {
            recurrence = null;
            refusal = $"Recurring template item '{sourceId}' needs a valid due date after its initialization rules are applied.";
            return false;
        }

        var untilValue = rule.Until;
        if (untilRule is not null)
        {
            switch (untilRule.Kind)
            {
                case TemplateInitializationRuleKind.Keep:
                    break;
                case TemplateInitializationRuleKind.Clear:
                    untilValue = null;
                    break;
                case TemplateInitializationRuleKind.Set:
                    if (untilRule.Value is not JsonValue literal
                        || !literal.TryGetValue(out string? literalText)
                        || !TryDate(literalText, out var literalDate))
                    {
                        recurrence = null;
                        refusal = "The recurrence-until value must be an ISO calendar day.";
                        return false;
                    }

                    untilValue = literalDate;
                    break;
                case TemplateInitializationRuleKind.Input:
                    if (!inputValues.TryGetValue(untilRule.InputKey!, out var inputText))
                    {
                        untilValue = null;
                        break;
                    }

                    if (!TryDate(inputText, out var inputDate))
                    {
                        recurrence = null;
                        refusal = $"Recurrence-until input '{untilRule.InputKey}' is not a valid date.";
                        return false;
                    }

                    untilValue = inputDate;
                    break;
                case TemplateInitializationRuleKind.RelativeDate:
                    if (!inputValues.TryGetValue(untilRule.InputKey!, out var baseText))
                    {
                        untilValue = null;
                        break;
                    }

                    if (!TryDate(baseText, out var baseDate))
                    {
                        recurrence = null;
                        refusal = $"Recurrence-until input '{untilRule.InputKey}' is not a valid date.";
                        return false;
                    }

                    try
                    {
                        untilValue = baseDate.AddDays(untilRule.OffsetDays!.Value);
                    }
                    catch (ArgumentOutOfRangeException)
                    {
                        recurrence = null;
                        refusal = "The relative recurrence-until date falls outside the supported calendar range.";
                        return false;
                    }

                    break;
            }
        }

        if (untilValue is { } until && until < anchor)
        {
            recurrence = null;
            refusal = $"Recurring template item '{sourceId}' ends before its initialized due date.";
            return false;
        }

        recurrence = RecurrenceRuleJson.Write(rule with
        {
            Until = untilValue,
            CompletedThrough = null,
            Completed = [],
        });
        refusal = null;
        return true;
    }

    private static bool TryDate(string? value, out DateOnly date) => DateOnly.TryParseExact(
        value,
        "yyyy-MM-dd",
        CultureInfo.InvariantCulture,
        DateTimeStyles.None,
        out date);

    private static bool TryReadBag(string? json, out JsonObject bag, out string refusal)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            bag = new JsonObject();
            refusal = string.Empty;
            return true;
        }

        try
        {
            if (JsonNode.Parse(json) is JsonObject parsed)
            {
                bag = parsed;
                refusal = string.Empty;
                return true;
            }
        }
        catch (System.Text.Json.JsonException)
        {
            // The caller returns a domain refusal rather than allowing malformed stored data to escape.
        }

        bag = new JsonObject();
        refusal = "an invalid JSON property bag.";
        return false;
    }

    private static TemplateInitializationResult EmptyResult(
        IReadOnlyDictionary<string, string> bindings,
        IReadOnlyList<TemplateReferenceRule> references) => new([], bindings, references);
}
