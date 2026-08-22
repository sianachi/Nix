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

            if (property.Type == PropertyType.Formula)
            {
                if (string.IsNullOrWhiteSpace(property.Expression))
                {
                    return $"'{property.Label}' is a formula and needs an expression.";
                }

                if (property.Expression.Length > FormulaReferences.MaximumExpressionLength)
                {
                    return $"'{property.Label}' has an expression longer than "
                        + $"{FormulaReferences.MaximumExpressionLength} characters, which is more "
                        + "than a formula property will evaluate.";
                }
            }
            else if (property.Expression is not null)
            {
                // Cheap to ignore and expensive to police is ADR-0020's rule for a field a kind
                // does not use - but an expression is not inert decoration. A property carrying one
                // while typed as text would evaluate the moment somebody retyped it to a formula,
                // silently, with an expression nobody had looked at since.
                return $"'{property.Label}' is not a formula, so it cannot carry an expression.";
            }

            // A computed property has no value to require: nothing writes one, so there is no
            // write for the requirement to be about.
            if (property.Type.IsComputed() && property.Required)
            {
                return $"'{property.Label}' is computed, so it cannot be required - "
                    + "nothing writes a value for it to be missing.";
            }
        }

        return RefuseCycle(schema);
    }

    /// <summary>
    /// Returns the reason a schema's formulas refer in a circle, or null.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Checked over the properties this schema declares, which is not the whole graph.</b> An
    /// effective schema merges ancestors, so a formula here can read one declared three levels up
    /// and the pair could close a circle that neither declaration shows on its own. The engine
    /// catches that case where it evaluates - anything on or downstream of a cycle reads
    /// <c>#CYCLE!</c> - which is the layer that sees the merged set. Refusing here is what stops
    /// the mistake somebody can actually see themselves making, in the editor they are making it
    /// in, rather than leaving a schema that stores fine and reads as an error everywhere.
    /// </para>
    /// <para>
    /// The alternative - resolving ancestors before accepting a schema - would make storing a
    /// schema depend on where the item currently sits, so moving an item could retroactively
    /// invalidate a declaration it was allowed to make. These rules are pure and stay pure.
    /// </para>
    /// </remarks>
    private static string? RefuseCycle(PropertySchema schema)
    {
        // Only the formulas that survived the loop above, which means every one of them has an
        // expression - so this map is non-null-valued by construction rather than by inspection.
        Dictionary<string, string>? formulas = null;
        foreach (var property in schema.Properties)
        {
            if (property.Type == PropertyType.Formula && property.Expression is { } expression)
            {
                formulas ??= new Dictionary<string, string>(StringComparer.Ordinal);
                formulas[property.Key] = expression;
            }
        }

        if (formulas is null)
        {
            return null;
        }

        return FormulaReferences.FindCycle(formulas) is { } key
            ? $"'{key}' is a formula that refers back to itself, directly or through another formula."
            : null;
    }
}
