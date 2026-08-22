using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Features.Properties;

/// <summary>
/// Maps between the property contract and the domain.
/// </summary>
/// <remarks>
/// The type name is a string on the wire and an enum in the domain, so this is where an
/// unrecognised type is refused rather than silently dropped: the reader that loads a stored schema
/// drops what it cannot interpret to stay total, and that is exactly wrong for a request somebody
/// is waiting on an answer to.
/// </remarks>
internal static class PropertyMapping
{
    /// <summary>Maps one definition onto the published shape.</summary>
    /// <param name="definition">The domain definition.</param>
    /// <returns>The published shape.</returns>
    internal static PropertyDefinitionResponse ToResponse(PropertyDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);

        return new PropertyDefinitionResponse(
            definition.Key,
            definition.Label,
            PropertyTypes.ToText(definition.Type),
            definition.Options,
            definition.Required,
            definition.Expression);
    }

    /// <summary>Maps a resolved schema onto the published shape.</summary>
    /// <param name="effective">The merged schema.</param>
    /// <param name="declared">What the item declares itself.</param>
    /// <returns>The published shape.</returns>
    internal static EffectiveSchemaResponse ToResponse(PropertySchema effective, PropertySchema declared)
    {
        ArgumentNullException.ThrowIfNull(effective);
        ArgumentNullException.ThrowIfNull(declared);

        return new EffectiveSchemaResponse(
            [.. effective.Properties.Select(ToResponse)],
            [.. declared.Properties.Select(ToResponse)],
            declared.Inherit);
    }

    /// <summary>
    /// Reads a requested schema, or says which property type it did not recognise.
    /// </summary>
    /// <param name="request">The request.</param>
    /// <param name="schema">The schema, when every type was recognised.</param>
    /// <param name="unknownType">The first unrecognised type name, when one was met.</param>
    /// <returns><see langword="true"/> when the request maps cleanly.</returns>
    internal static bool TryToDomain(
        SetSchemaRequest request,
        out PropertySchema schema,
        out string? unknownType)
    {
        ArgumentNullException.ThrowIfNull(request);

        var properties = ImmutableArray.CreateBuilder<PropertyDefinition>(request.Properties.Count);

        foreach (var property in request.Properties)
        {
            if (!PropertyTypes.TryParse(property.Type, out var type))
            {
                schema = PropertySchema.Empty;
                unknownType = property.Type;
                return false;
            }

            properties.Add(
                new PropertyDefinition(
                    property.Key,
                    property.Label.Length == 0 ? property.Key : property.Label,
                    type,
                    property.Options is null ? [] : [.. property.Options],
                    property.Required,
                    // Empty and absent are one thing here. A client that sends "" for every
                    // property rather than omitting the field would otherwise declare an
                    // expression on each of them, which PropertySchemaRules then refuses on types
                    // that cannot carry one - a refusal about a field the caller never filled in.
                    string.IsNullOrWhiteSpace(property.Expression) ? null : property.Expression));
        }

        schema = new PropertySchema { Properties = properties.ToImmutable(), Inherit = request.Inherit };
        unknownType = null;
        return true;
    }
}
