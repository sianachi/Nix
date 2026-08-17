using Nix.Domain.Items;

namespace Nix.Domain.Properties;

/// <summary>Pure storage rules shared by every schema-writing boundary.</summary>
public static class PropertySchemaRules
{
    /// <summary>Returns the first reason a schema cannot be stored, or null.</summary>
    public static string? Refuse(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in schema.Properties)
        {
            if (property.Key.Length == 0)
            {
                return "Every property needs a key.";
            }

            if (!keys.Add(property.Key))
            {
                return $"'{property.Key}' is declared more than once; a property cannot mean two things.";
            }

            if (string.Equals(property.Key, ItemProperties.TitleKey, StringComparison.Ordinal))
            {
                return "'title' is managed by the item itself and cannot be redeclared.";
            }

            if (property.Type.HasOptions() && property.Options.IsEmpty)
            {
                return $"'{property.Label}' is a select and needs at least one option.";
            }

            if (!property.Type.HasOptions() && !property.Options.IsEmpty)
            {
                return $"'{property.Label}' is not a select, so it cannot carry options.";
            }
        }

        return null;
    }
}
