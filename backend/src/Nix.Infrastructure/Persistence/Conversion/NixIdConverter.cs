using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Nix.Core.Primitives;

namespace Nix.Infrastructure.Persistence.Conversion;

/// <summary>
/// Maps any typed identifier to the <c>uuid</c> column behind it.
/// </summary>
/// <typeparam name="TId">The identifier type.</typeparam>
/// <remarks>
/// <para>
/// One converter for every identifier in the domain, rather than one per identifier, because
/// <see cref="INixId{TSelf}"/> supplies the only two operations a converter needs: read the value,
/// and rebuild from a value. Registering it is a single line per type in
/// <c>NixDbContext.ConfigureConventions</c>, so a new identifier costs a struct and nothing else -
/// there is no mapping file to forget to write, and no way for one identifier to be mapped
/// differently from the rest.
/// </para>
/// <para>
/// Both directions compile to a field read and a constructor call. The struct is a single
/// <see cref="Guid"/> field, so nothing is boxed and nothing is allocated on either path.
/// </para>
/// <para>
/// Public rather than internal because EF constructs it reflectively from
/// <c>ConfigureConventions</c>, where no instance overload exists to construct it explicitly. The
/// type is a genuine part of how the domain meets the database, so exposing it is honest rather
/// than a workaround.
/// </para>
/// </remarks>
public sealed class NixIdConverter<TId> : ValueConverter<TId, Guid>
    where TId : struct, INixId<TId>
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NixIdConverter{TId}"/> class.
    /// </summary>
    public NixIdConverter()
        : base(id => id.Value, value => NixId.From<TId>(value))
    {
    }
}

/// <summary>
/// Calls <see cref="INixId{TSelf}.From"/> from somewhere an expression tree can reach it.
/// </summary>
/// <remarks>
/// A static abstract interface member cannot appear in an expression tree - the call has no
/// representation until the type argument is known - and <see cref="ValueConverter{TModel,
/// TProvider}"/> takes expressions. Routing through an ordinary static generic method puts the
/// constrained call inside a method body, which the tree can then simply invoke. The indirection
/// is erased at JIT time.
/// </remarks>
internal static class NixId
{
    /// <summary>Rebuilds a typed identifier from its stored value.</summary>
    /// <typeparam name="TId">The identifier type.</typeparam>
    /// <param name="value">The stored value.</param>
    /// <returns>The typed identifier.</returns>
    internal static TId From<TId>(Guid value)
        where TId : struct, INixId<TId> => TId.From(value);
}
