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
}
