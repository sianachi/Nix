using System.Collections.Immutable;

namespace Nix.Core.Properties;

/// <summary>
/// The property definitions one container declares for itself and its descendants.
/// </summary>
/// <remarks>
/// <para>
/// A schema is authored on an item and applies down the subtree. What a descendant actually sees
/// is the <b>effective</b> schema - this one merged with every ancestor's, nearest declaration of
/// a key winning. See ADR-0007; the merge itself is <see cref="Merge"/>.
/// </para>
/// <para>
/// <b><see cref="Inherit"/> is about the chain above, not this schema.</b> Setting it false makes
/// this the outermost schema its subtree sees: nothing higher contributes. The case it exists for
/// is a scratch folder under a heavily-schema'd workspace, where inheriting a dozen required
/// properties would make every note in it invalid on arrival.
/// </para>
/// </remarks>
public sealed record PropertySchema
{
    /// <summary>A schema declaring nothing, which is what an item with no schema resolves to.</summary>
    public static PropertySchema Empty { get; } = new()
    {
        Properties = [],
        Inherit = true,
    };

    /// <summary>Gets the declared properties, in the order they should be offered.</summary>
    /// <remarks>
    /// Ordered rather than a dictionary because the order is authored: it decides column order in
    /// a list view and field order in a panel. A dictionary would make that order an accident of
    /// hashing.
    /// </remarks>
    public required ImmutableArray<PropertyDefinition> Properties { get; init; }

    /// <summary>
    /// Gets whether ancestors above the declaring item contribute to the effective schema.
    /// </summary>
    public required bool Inherit { get; init; }

    /// <summary>Whether this schema declares nothing at all.</summary>
    public bool IsEmpty => Properties.IsEmpty;

    /// <summary>Finds a declared property by key.</summary>
    /// <param name="key">The property key.</param>
    /// <returns>The definition, or <see langword="null"/> when the schema does not declare it.</returns>
    public PropertyDefinition? Find(string key) =>
        Properties.FirstOrDefault(property => string.Equals(property.Key, key, StringComparison.Ordinal));

    /// <summary>
    /// Merges a nearer schema over a farther one.
    /// </summary>
    /// <param name="farther">The schema from further up the chain.</param>
    /// <param name="nearer">The schema closer to the item.</param>
    /// <returns>The merged schema.</returns>
    /// <remarks>
    /// <para>
    /// <b>Nearer wins, per key</b>, which is what lets a project folder narrow a workspace-wide
    /// property for its own subtree without the workspace losing it everywhere else. Root-wins
    /// would make the outermost declaration unoverridable and turn any shared schema into a
    /// commitment nobody could walk back.
    /// </para>
    /// <para>
    /// Order is farther-first, with a nearer redefinition kept in the position the farther schema
    /// gave it. Otherwise overriding one property would shuffle a list view's columns, which reads
    /// as a bug to everybody who did not make the edit.
    /// </para>
    /// </remarks>
    public static PropertySchema Merge(PropertySchema farther, PropertySchema nearer)
    {
        ArgumentNullException.ThrowIfNull(farther);
        ArgumentNullException.ThrowIfNull(nearer);

        // The shortcuts still have to honour the inheritance rule below: returning the farther
        // schema verbatim would hand back its flag, and a caller that trusted the merged one would
        // then inherit straight through a declaration that refused to. Nothing does that today,
        // which is exactly why it would be found late.
        if (nearer.IsEmpty)
        {
            return farther.Inherit == nearer.Inherit ? farther : farther with { Inherit = nearer.Inherit };
        }

        if (farther.IsEmpty)
        {
            return nearer;
        }

        var merged = ImmutableArray.CreateBuilder<PropertyDefinition>(
            farther.Properties.Length + nearer.Properties.Length);

        var overridden = new HashSet<string>(StringComparer.Ordinal);

        foreach (var property in farther.Properties)
        {
            var replacement = nearer.Find(property.Key);
            if (replacement is null)
            {
                merged.Add(property);
                continue;
            }

            merged.Add(replacement);
            overridden.Add(replacement.Key);
        }

        foreach (var property in nearer.Properties)
        {
            if (!overridden.Contains(property.Key))
            {
                merged.Add(property);
            }
        }

        return new PropertySchema
        {
            Properties = merged.ToImmutable(),

            // The merged result carries the nearer item's inheritance flag, because that is the
            // one a further merge has to obey.
            Inherit = nearer.Inherit,
        };
    }
}
