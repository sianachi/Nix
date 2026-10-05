using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Nix.Persistence.Conversion;

/// <summary>
/// Maps a <see cref="ReadOnlyMemory{T}"/> payload to a <c>bytea</c> column.
/// </summary>
/// <remarks>
/// <para>
/// The domain type is <see cref="ReadOnlyMemory{T}"/> rather than an array for two reasons: an
/// array property is mutable through its own reference, which the analysers rightly object to, and
/// memory is the type the memory rules ask for when a payload crosses an await. The provider only
/// understands arrays, so the copy happens here, in one place, instead of at every call site.
/// </para>
/// <para>
/// <b>Both directions copy, and that is why Core should not read these columns in bulk.</b> Core
/// holds SELECT on the content tables so that export and search can reach them one document at a
/// time; it is not the service that streams a document's history. The collaboration service owns
/// that path and talks to Postgres directly. Anything here that finds itself materialising many
/// updates at once should be streaming instead - see
/// <c>NixSqlExecutor.OpenColumnStreamAsync</c>, which exists for exactly that.
/// </para>
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    // Justification: constructed in the entity configurations, which the analyser does not follow
    // through EF's builder API.
    Justification = "Constructed by the entity configurations.")]
internal sealed class BinaryPayloadConverter : ValueConverter<ReadOnlyMemory<byte>, byte[]>
{
    /// <summary>Initializes a new instance of the <see cref="BinaryPayloadConverter"/> class.</summary>
    public BinaryPayloadConverter()
        // byte[]: Npgsql maps bytea to byte[] and offers no memory-shaped overload for a mapped
        // property. The copy is confined to this converter.
        : base(payload => payload.ToArray(), stored => new ReadOnlyMemory<byte>(stored))
    {
    }

    /// <summary>
    /// Compares payloads by content rather than by reference.
    /// </summary>
    /// <remarks>
    /// Required because <see cref="ReadOnlyMemory{T}"/> has no structural equality EF can use, so
    /// without this a tracked payload would compare by reference and every change would look like
    /// no change. Tracking is off by default, so this runs only where a caller opted in.
    /// </remarks>
    internal static ValueComparer<ReadOnlyMemory<byte>> Comparer { get; } = new(
        (left, right) => ContentEquals(left, right),
        payload => payload.Length,
        payload => new ReadOnlyMemory<byte>(payload.ToArray()));

    /// <summary>
    /// Compares two payloads byte for byte.
    /// </summary>
    /// <remarks>
    /// A method rather than an inline lambda because an expression tree cannot hold a
    /// <see cref="Span{T}"/> - it is a ref struct, and the tree would have to box it. Putting the
    /// span behind a call keeps it on the stack where it belongs.
    /// </remarks>
    private static bool ContentEquals(ReadOnlyMemory<byte> left, ReadOnlyMemory<byte> right) =>
        left.Span.SequenceEqual(right.Span);
}
