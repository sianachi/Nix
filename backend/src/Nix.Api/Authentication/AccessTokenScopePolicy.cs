using Microsoft.AspNetCore.Http;
using Nix.Domain.Identity;

namespace Nix.Authentication;

/// <summary>
/// Classifies every route into the scope a personal access token must hold to call it.
/// </summary>
/// <remarks>
/// <para>
/// <b>The classification is by shape, not by endpoint list, and that is a safety property.</b>
/// The default for anything unrecognised is the strictest reading its method allows: a read needs
/// <see cref="AccessTokenScope.Read"/>, everything else needs <see cref="AccessTokenScope.Write"/>,
/// and the narrow set of routes that change who can see what needs
/// <see cref="AccessTokenScope.Admin"/>. A new endpoint therefore arrives classified - possibly
/// too strictly, never too loosely - and the contract test that walks the OpenAPI document
/// (<c>AccessTokenScopePolicyTests</c>) is where each operation's class is made deliberate.
/// </para>
/// <para>
/// <b>Token management is not a scope; it is refused outright.</b> A token that could list, mint
/// or revoke tokens could quietly extend its own life past every ceiling its issuer chose.
/// Managing tokens is something a person does in an interactive session.
/// </para>
/// <para>
/// This applies only to token-authenticated sessions. An interactive principal is not scoped -
/// their permissions are the ceiling - so the middleware consults this only when the validated
/// token names an access-token row.
/// </para>
/// </remarks>
public static class AccessTokenScopePolicy
{
    /// <summary>What a route demands of a token-authenticated caller.</summary>
    public enum Requirement
    {
        /// <summary>The token must hold <see cref="AccessTokenScope.Read"/>.</summary>
        Read,

        /// <summary>The token must hold <see cref="AccessTokenScope.Write"/>.</summary>
        Write,

        /// <summary>The token must hold <see cref="AccessTokenScope.Admin"/>.</summary>
        Admin,

        /// <summary>No scope admits a token here; only an interactive session may call it.</summary>
        InteractiveOnly,
    }

    /// <summary>
    /// Classifies one request.
    /// </summary>
    /// <param name="method">The HTTP method.</param>
    /// <param name="path">The request path.</param>
    /// <returns>What the route demands.</returns>
    public static Requirement Classify(string method, PathString path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(method);

        if (path.StartsWithSegments("/api/v1/me/tokens", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.InteractiveOnly;
        }

        var value = path.Value ?? string.Empty;

        // Admin surfaces, whichever method reaches them, because each changes or exposes who can
        // see what rather than what there is to see:
        //  - `/public-link` publishes a view to the anonymous internet, and its GET reads back a
        //    live submission URL - a write capability, not data - so the read is admin too;
        //  - `/move` re-parents an item, which through closure inheritance can hand its contents
        //    to everyone who can see the new parent.
        // These are matched before the read shortcut precisely so a GET does not slip through as
        // a plain read.
        if (value.Contains("/public-link", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/move", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/invitees", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        if (IsRead(method))
        {
            return Requirement.Read;
        }

        // Workspace membership administration changes who can reach an entire item tree. The
        // database role remains the authority; an admin-scoped token is an additional ceiling.
        if (value.Contains("/members", StringComparison.OrdinalIgnoreCase)
            || value.Contains("/invitations", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/leave", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/recover", StringComparison.OrdinalIgnoreCase)
            // Plugin writes pin publisher trust or grant executable components access to
            // workspace data. Listing installations remains a read through the shortcut above.
            || value.Contains("/plugins", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        // Permission entries are the remaining admin write: they name who may act, and reading
        // the ACL (a GET, already returned as Read above) is data disclosure rather than a
        // capability, so only the writes land here.
        if (value.Contains("/permissions", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        return Requirement.Write;
    }

    /// <summary>
    /// Whether a set of held scopes satisfies a requirement.
    /// </summary>
    /// <param name="held">The scopes on the token row, in their storage spelling.</param>
    /// <param name="requirement">What the route demands.</param>
    /// <returns>Whether the request may proceed.</returns>
    /// <remarks>
    /// Scopes are independent rather than ordered: a write-only token exists (an ingest that
    /// should never be able to exfiltrate), so holding <c>write</c> does not imply <c>read</c>.
    /// An unrecognised string in the column satisfies nothing - the safe reading of a scope this
    /// build cannot interpret is "not granted".
    /// </remarks>
    public static bool Satisfies(IReadOnlyList<string> held, Requirement requirement)
    {
        ArgumentNullException.ThrowIfNull(held);

        if (requirement == Requirement.InteractiveOnly)
        {
            return false;
        }

        var needed = requirement switch
        {
            Requirement.Read => AccessTokenScopes.Read,
            Requirement.Write => AccessTokenScopes.Write,
            Requirement.Admin => AccessTokenScopes.Admin,
            _ => throw new ArgumentOutOfRangeException(nameof(requirement), requirement, "Unknown requirement."),
        };

        for (var index = 0; index < held.Count; index++)
        {
            if (string.Equals(held[index], needed, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Names a requirement the way a problem document should: as the scope the caller lacked.
    /// </summary>
    /// <param name="requirement">The unmet requirement.</param>
    /// <returns>The scope's storage spelling, or a sentence for the interactive-only case.</returns>
    public static string Describe(Requirement requirement) => requirement switch
    {
        Requirement.Read => AccessTokenScopes.Read,
        Requirement.Write => AccessTokenScopes.Write,
        Requirement.Admin => AccessTokenScopes.Admin,
        Requirement.InteractiveOnly => "an interactive session",
        _ => throw new ArgumentOutOfRangeException(nameof(requirement), requirement, "Unknown requirement."),
    };

    private static bool IsRead(string method) =>
        HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
}
