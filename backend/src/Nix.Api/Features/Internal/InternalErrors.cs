using Nix.Domain.Primitives;

namespace Nix.Features.Internal;

/// <summary>
/// The expected failures of the internal surface, and the stable codes it answers with.
/// </summary>
/// <remarks>
/// One code, deliberately: an internal caller refused for any reason - the item does not exist,
/// is not visible, or the principal may not do what the call implies - hears the same thing.
/// The collaboration service treats it uniformly as "close or refuse the session", and a richer
/// taxonomy here would only leak which refusals mean "exists but not yours".
/// </remarks>
public static class InternalErrors
{
    /// <summary>The request cannot be safely accepted.</summary>
    public static NixError InvalidRequest(string detail) => new("internal.invalid_request", detail);

    /// <summary>No such item, or the acting principal may not act on it as the call implies.</summary>
    public static NixError NotFound(string detail) => new("internal.not_found", detail);

    /// <summary>Stable code for an item the caller may read whose body is locked to them.</summary>
    public const string BodyLockedCode = "internal.body_locked";

    /// <summary>
    /// The item is readable but its body is locked to this credential. Distinct from not found on
    /// purpose: whoever may read the item can already ask Core whether it is locked, so saying so
    /// here discloses nothing, and a client told "not found" for a locked note cannot tell the
    /// person to unlock it.
    /// </summary>
    public static NixError BodyLocked(string detail) => new(BodyLockedCode, detail);
}
