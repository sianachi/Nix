using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Core.Properties;

/// <summary>
/// One reason a property bag was refused.
/// </summary>
/// <param name="Key">The property at fault.</param>
/// <param name="Reason">What is wrong with it, in terms a person can act on.</param>
public sealed record PropertyViolation(string Key, string Reason);

/// <summary>
/// Checks a property bag against the schema in force where the item sits.
/// </summary>
/// <remarks>
/// <para>
/// <b>Declared keys are checked strictly; undeclared keys are left alone.</b> That asymmetry is
/// ADR-0007 §4 and it is deliberate. A schema is edited by people, and if removing a property made
/// every existing value illegal, one schema edit would break the next write to every item beneath
/// it - on data the writer never touched. Preserving them means a property dropped from a schema
/// stops being validated and stops being displayed, and returns intact if the schema does.
/// </para>
/// <para>
/// It is also what keeps <c>title</c> working: it lives in the property bag and no schema declares
/// it.
/// </para>
/// <para>
/// <b>Every violation is reported, not just the first.</b> A form with three bad fields should say
/// so once rather than over three round trips.
/// </para>
/// </remarks>
public static class PropertyValidator
{
    /// <summary>The largest a property bag may be, matching the column's own bound.</summary>
    /// <remarks>
    /// Checked here as well as by the database so an oversized bag is a problem document naming
    /// the limit rather than a constraint violation surfacing as a 500.
    /// </remarks>
    public const int MaximumBytes = 32 * 1024;

    /// <summary>
    /// Validates a property bag.
    /// </summary>
    /// <param name="properties">The bag as stored JSON, or <see langword="null"/>.</param>
    /// <param name="schema">The effective schema at the item's position.</param>
    /// <returns>Every violation found, empty when the bag is acceptable.</returns>
    public static ImmutableArray<PropertyViolation> Validate(string? properties, PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        if (properties is not null && System.Text.Encoding.UTF8.GetByteCount(properties) > MaximumBytes)
        {
            return
            [
                new PropertyViolation(
                    string.Empty,
                    $"A property bag may be at most {MaximumBytes} bytes."),
            ];
        }

        JsonObject? bag;
        try
        {
            bag = properties is null ? null : JsonNode.Parse(properties) as JsonObject;
        }
        catch (JsonException)
        {
            return [new PropertyViolation(string.Empty, "The properties are not valid JSON.")];
        }

        if (properties is not null && bag is null)
        {
            return [new PropertyViolation(string.Empty, "The properties must be a JSON object.")];
        }

        var violations = ImmutableArray.CreateBuilder<PropertyViolation>();

        foreach (var definition in schema.Properties)
        {
            var value = bag?[definition.Key];

            if (IsAbsent(value))
            {
                if (definition.Required)
                {
                    violations.Add(new PropertyViolation(definition.Key, $"{definition.Label} is required."));
                }

                continue;
            }

            var reason = Check(definition, value);
            if (reason is not null)
            {
                violations.Add(new PropertyViolation(definition.Key, reason));
            }
        }

        return violations.ToImmutable();
    }

    /// <summary>
    /// Whether a value counts as not supplied.
    /// </summary>
    /// <remarks>
    /// An explicit null is the same as absent, because that is what a client clearing a field
    /// sends. Treating them differently would make "required" satisfiable by sending null.
    /// </remarks>
    private static bool IsAbsent(JsonNode? value) => value is null;

    private static string? Check(PropertyDefinition definition, JsonNode? value) => definition.Type switch
    {
        PropertyType.Text => ReadString(value) is null ? $"{definition.Label} must be text." : null,

        PropertyType.Number => value is JsonValue number && number.TryGetValue(out double _)
            ? null
            : $"{definition.Label} must be a number.",

        PropertyType.Checkbox => value is JsonValue flag && flag.TryGetValue(out bool _)
            ? null
            : $"{definition.Label} must be true or false.",

        PropertyType.Date => CheckDate(definition, value),
        PropertyType.Url => CheckUrl(definition, value),
        PropertyType.Select => CheckSelect(definition, value),
        PropertyType.MultiSelect => CheckMultiSelect(definition, value),

        _ => null,
    };

    private static string? CheckDate(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        // ISO 8601 date, no time and no zone. A property that means "the 3rd" must not shift to
        // the 2nd for a reader in another zone, which is exactly what storing an instant would do.
        return text is not null
            && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            ? null
            : $"{definition.Label} must be a date, as yyyy-MM-dd.";
    }

    private static string? CheckUrl(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        // Absolute only, and only over http. A relative URL has no meaning outside the page it was
        // written on, and allowing arbitrary schemes here would put javascript: one render away
        // from being clicked.
        return text is not null
            && Uri.TryCreate(text, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? null
            : $"{definition.Label} must be an http or https address.";
    }

    private static string? CheckSelect(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);
        if (text is null)
        {
            return $"{definition.Label} must be one of its options.";
        }

        return definition.Allows(text)
            ? null
            : $"{definition.Label} does not offer '{text}'.";
    }

    private static string? CheckMultiSelect(PropertyDefinition definition, JsonNode? value)
    {
        if (value is not JsonArray values)
        {
            return $"{definition.Label} must be a list of its options.";
        }

        foreach (var entry in values)
        {
            var text = ReadString(entry);
            if (text is null)
            {
                // Named as what it is rather than as "null": a bag carrying a number where a
                // select value belongs is a different mistake from one carrying a value the
                // schema does not offer, and a message that conflated them would send somebody
                // checking their options list for an entry that was never the problem.
                return $"{definition.Label} takes text values; '{entry?.ToJsonString() ?? "null"}' is not one.";
            }

            if (!definition.Allows(text))
            {
                return $"{definition.Label} does not offer '{text}'.";
            }
        }

        return null;
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
