using System.Collections.Immutable;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;

namespace Nix.Features.Properties;

/// <summary>
/// The expected failures of the property and view features, and the stable codes clients branch on.
/// </summary>
/// <remarks>
/// Declared once rather than constructed at each call site, for the same reason the item feature's
/// are: the code is the part clients switch on, and a typo in one is a bug nobody notices until a
/// frontend stops handling a case it used to.
/// </remarks>
public static class PropertyErrors
{
    /// <summary>Stable code for a property bag that does not fit the schema in force.</summary>
    public const string InvalidPropertiesCode = "properties.invalid";

    /// <summary>Stable code for a schema document that could not be accepted.</summary>
    public const string InvalidSchemaCode = "schema.invalid";

    /// <summary>Stable code for a view set that could not be accepted.</summary>
    public const string InvalidViewsCode = "views.invalid";

    /// <summary>Stable code for a guided setup colliding with configuration added meanwhile.</summary>
    public const string SetupCollisionCode = "structure.setup_collision";

    /// <summary>
    /// One or more property values do not fit the schema.
    /// </summary>
    /// <param name="violations">Every violation, so a form reports them all at once.</param>
    /// <returns>The error.</returns>
    /// <remarks>
    /// The violations are joined into the message rather than carried as structured data, because
    /// <see cref="NixError"/> is a code and a sentence. When the interface needs to put each one
    /// against its own field, this is the place that grows a typed payload - and the code stays the
    /// same, so nothing branching on it has to change.
    /// </remarks>
    public static NixError InvalidProperties(ImmutableArray<PropertyViolation> violations) =>
        new(
            InvalidPropertiesCode,
            violations.IsDefaultOrEmpty
                ? "The properties do not fit this item's schema."
                : string.Join(" ", violations.Select(violation => violation.Reason)));

    /// <summary>The schema document was refused.</summary>
    /// <param name="detail">Why.</param>
    /// <returns>The error.</returns>
    public static NixError InvalidSchema(string detail) => new(InvalidSchemaCode, detail);

    /// <summary>The view set was refused.</summary>
    /// <param name="detail">Why.</param>
    /// <returns>The error.</returns>
    public static NixError InvalidViews(string detail) => new(InvalidViewsCode, detail);

    /// <summary>A field or view identifier was claimed after a wizard draft was opened.</summary>
    public static NixError SetupCollision(string detail) => new(SetupCollisionCode, detail);
}
