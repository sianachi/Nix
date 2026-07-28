using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Properties;

/// <summary>
/// Reads and writes a <see cref="PropertySchema"/> as the JSON stored in <c>item.schema</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the seam ADR-0006 rests on.</b> A schema is parsed out of the column here and is
/// never handled as raw JSON above it, so moving schemas into tables later changes where the bytes
/// come from and nothing else.
/// </para>
/// <para>
/// <b>Reading is total; writing is not.</b> A stored schema is data a person authored through an
/// endpoint that validated it - but it is also data that an older build may not fully understand,
/// and a schema that fails to parse must not make the items beneath it unreadable. So reading
/// drops what it cannot interpret and keeps the rest, and the endpoint that accepts a schema is
/// where malformed input is refused with something a person can act on.
/// </para>
/// <para>
/// The shape:
/// <code>
/// {
///   "inherit": true,
///   "properties": [
///     { "key": "status", "label": "Status", "type": "select",
///       "options": ["Todo", "Doing", "Done"], "required": false }
///   ]
/// }
/// </code>
/// </para>
/// </remarks>
public static class PropertySchemaJson
{
    private const string PropertiesKey = "properties";
    private const string InheritKey = "inherit";
    private const string KeyKey = "key";
    private const string LabelKey = "label";
    private const string TypeKey = "type";
    private const string OptionsKey = "options";
    private const string RequiredKey = "required";

    /// <summary>
    /// Reads a stored schema.
    /// </summary>
    /// <param name="json">The stored JSON, or <see langword="null"/> when the item declares none.</param>
    /// <returns>The schema, or <see cref="PropertySchema.Empty"/> when there is nothing usable.</returns>
    /// <remarks>
    /// Never throws. A malformed schema resolves to an empty one, which means the items beneath it
    /// are validated against less rather than becoming unreadable - the same posture the title
    /// reader takes for the same reason.
    /// </remarks>
    public static PropertySchema Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return PropertySchema.Empty;
        }

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return PropertySchema.Empty;
        }

        if (root is not JsonObject document)
        {
            return PropertySchema.Empty;
        }

        var inherit = document[InheritKey] is JsonValue value && value.TryGetValue(out bool flag)
            ? flag
            : true;

        if (document[PropertiesKey] is not JsonArray declared)
        {
            return new PropertySchema { Properties = [], Inherit = inherit };
        }

        var properties = ImmutableArray.CreateBuilder<PropertyDefinition>(declared.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var entry in declared)
        {
            var definition = ReadDefinition(entry);

            // A duplicate key is a schema that cannot mean two things at once. The first wins,
            // because the alternative is a property whose behaviour depends on array order in a
            // way nobody authored deliberately.
            if (definition is not null && seen.Add(definition.Key))
            {
                properties.Add(definition);
            }
        }

        return new PropertySchema { Properties = properties.ToImmutable(), Inherit = inherit };
    }

    /// <summary>
    /// Writes a schema for storage.
    /// </summary>
    /// <param name="schema">The schema.</param>
    /// <returns>The JSON to store.</returns>
    public static string Write(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        var properties = new JsonArray();
        foreach (var property in schema.Properties)
        {
            var entry = new JsonObject
            {
                [KeyKey] = property.Key,
                [LabelKey] = property.Label,
                [TypeKey] = PropertyTypes.ToText(property.Type),
                [RequiredKey] = property.Required,
            };

            if (!property.Options.IsEmpty)
            {
                var options = new JsonArray();
                foreach (var option in property.Options)
                {
                    options.Add(option);
                }

                entry[OptionsKey] = options;
            }

            properties.Add(entry);
        }

        var document = new JsonObject
        {
            [InheritKey] = schema.Inherit,
            [PropertiesKey] = properties,
        };

        return document.ToJsonString();
    }

    private static PropertyDefinition? ReadDefinition(JsonNode? entry)
    {
        if (entry is not JsonObject property)
        {
            return null;
        }

        var key = ReadString(property[KeyKey]);
        if (key is null || key.Length == 0)
        {
            return null;
        }

        if (!PropertyTypes.TryParse(ReadString(property[TypeKey]), out var type))
        {
            // A type this build does not know is not a type. Dropped rather than guessed at, so an
            // older instance stops validating a property instead of inventing a rule for it.
            return null;
        }

        var options = ImmutableArray<string>.Empty;
        if (type.HasOptions() && property[OptionsKey] is JsonArray declared)
        {
            var builder = ImmutableArray.CreateBuilder<string>(declared.Count);
            foreach (var option in declared)
            {
                var text = ReadString(option);
                if (text is not null && !builder.Contains(text, StringComparer.Ordinal))
                {
                    builder.Add(text);
                }
            }

            options = builder.ToImmutable();
        }

        var required = property[RequiredKey] is JsonValue flag && flag.TryGetValue(out bool value) && value;

        return new PropertyDefinition(
            key,
            ReadString(property[LabelKey]) ?? key,
            type,
            options,
            required);
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
