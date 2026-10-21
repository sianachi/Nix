namespace Nix.Http;

/// <summary>
/// Hosts that may be reached over plain HTTP: loopback addresses and names under the reserved
/// <c>.localhost</c> domain (RFC 6761), which browsers resolve to loopback. A one-machine install
/// runs Core in a container, where <c>localhost</c> is the container itself, so it addresses the
/// stack as <c>nix.localhost</c> instead.
/// </summary>
public static class LocalHost
{
    /// <summary>Whether the URI's host is loopback or a <c>.localhost</c> name.</summary>
    public static bool IsLocal(this Uri uri)
    {
        ArgumentNullException.ThrowIfNull(uri);
        return uri.IsLoopback || uri.IdnHost.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
    }
}
