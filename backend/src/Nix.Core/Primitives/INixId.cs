namespace Nix.Core.Primitives;

/// <summary>
/// The shape every typed identifier in the domain shares: a wrapper over a <see cref="Guid"/> that
/// can be rebuilt from one.
/// </summary>
/// <typeparam name="TSelf">The implementing identifier type.</typeparam>
/// <remarks>
/// <para>
/// Typed identifiers exist because <c>Guid</c> parameters are interchangeable and the compiler
/// cannot tell you that <c>Move(itemId, workspaceId)</c> was called with the arguments the other
/// way round. Wrapping each one costs nothing at runtime - a single-field readonly struct is the
/// same 16 bytes as the <c>Guid</c> it holds, passed the same way - and turns that class of bug
/// into a build failure.
/// </para>
/// <para>
/// The static abstract <see cref="From"/> is what makes the set worth an interface rather than
/// eight unrelated structs: infrastructure can write <i>one</i> generic EF Core value converter
/// constrained on this interface instead of one converter per identifier. Adding an identifier
/// then costs a single file and no mapping code at all.
/// </para>
/// <para>
/// Implementations live in their feature folder next to the entity they identify, not in a shared
/// bag of identifiers, so a folder stays readable on its own.
/// </para>
/// <para>
/// Every implementation mints new values with <see cref="Guid.CreateVersion7()"/> rather than
/// <see cref="Guid.NewGuid()"/>. Version 7 embeds a millisecond timestamp in the high bits, so
/// freshly minted keys sort near each other and insert into the right-hand edge of the primary
/// key's B-tree instead of scattering across it. Random version 4 keys dirty a new page per
/// insert, which shows up as write amplification and a colder cache on exactly the tables that
/// grow fastest (<c>item</c>, <c>item_closure</c>, <c>audit_event</c>).
/// </para>
/// </remarks>
public interface INixId<TSelf>
    where TSelf : struct, INixId<TSelf>
{
    /// <summary>Gets the underlying value as stored in the database.</summary>
    public Guid Value { get; }

    /// <summary>Rebuilds the identifier from a database value.</summary>
    /// <param name="value">The stored value.</param>
    /// <returns>The typed identifier.</returns>
    public static abstract TSelf From(Guid value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    /// <remarks>
    /// On the interface rather than left to convention on each struct, so the version 7 discipline
    /// described below cannot be quietly dropped by the next identifier someone adds.
    /// </remarks>
    public static abstract TSelf Create();
}
