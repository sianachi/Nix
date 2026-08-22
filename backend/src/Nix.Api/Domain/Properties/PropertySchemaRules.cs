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

            // A task type names a role, and the role's key is the role's name. A smart list that
            // means "the due date" is compiled cross-workspace against a key, so a workspace-chosen
            // key would leave 3.4 replacing one convention with another - and the storage
            // projection in the migration (item.due_day) can only be generated from a key that is
            // fixed. Label stays free; that is where a workspace calls it "Deadline". This rule
            // also makes "at most one property per task type" emergent rather than checked: a
            // second due_date would have to reuse the key, and the duplicate-key rule above has
            // already refused that.
            if (property.Type.IsTaskSemantic()
                && !string.Equals(property.Key, PropertyTypes.ToText(property.Type), StringComparison.Ordinal))
            {
                return $"A {PropertyTypes.ToText(property.Type)} property must use the key "
                    + $"'{PropertyTypes.ToText(property.Type)}'; '{property.Key}' is a different name "
                    + "for a role the whole workspace has to agree on. Rename the label instead.";
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
