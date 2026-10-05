using System.Net;

namespace Nix.Http;

/// <summary>
/// The one way a pre-authentication surface identifies a caller: its address.
/// </summary>
/// <remarks>
/// <para>
/// Both baseline limiters partition on this - the writes rate limiter and the failed-authentication
/// throttle - so they agree about who "one client" is, and a change of mind about the answer is a
/// change in one place.
/// </para>
/// <para>
/// An <see cref="IPAddress"/> rather than its string form on purpose. The address is read on every
/// request that reaches either limiter, which is the hottest path in the process;
/// <see cref="IPAddress"/> already has value equality and a hash code, so partitioning on it
/// directly removes a per-request formatting allocation (46-94 bytes for the string alone) that
/// bought nothing.
/// </para>
/// <para>
/// <see cref="IPAddress.None"/> stands in when the connection has no remote address - an in-memory
/// transport, or a Unix socket. Callers with no address share one partition, which is the
/// conservative choice: it can only make a limit stricter, never a caller anonymous.
/// </para>
/// </remarks>
public static class ClientKey
{
    /// <summary>The address the limiters partition <paramref name="context"/> on.</summary>
    /// <param name="context">The request being keyed.</param>
    /// <returns>
    /// The connection's remote address, which <c>UseForwardedHeaders</c> has already replaced with
    /// the originating client's address when the request arrived through a trusted proxy.
    /// </returns>
    public static IPAddress For(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        return context.Connection.RemoteIpAddress ?? IPAddress.None;
    }
}
