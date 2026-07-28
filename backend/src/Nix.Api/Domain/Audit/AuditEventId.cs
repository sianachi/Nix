using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Audit;

/// <summary>
/// Identifies an audit event. Events are insert-only and never updated, so this value is assigned
/// once and is stable for the lifetime of the record.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct AuditEventId(Guid Value) : INixId<AuditEventId>
{
    /// <inheritdoc />
    public static AuditEventId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static AuditEventId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
