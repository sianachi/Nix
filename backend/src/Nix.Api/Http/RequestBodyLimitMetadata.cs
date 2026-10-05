namespace Nix.Http;

/// <summary>
/// Endpoint metadata declaring the request-body bound for one route, where it differs from the
/// host-wide Kestrel ceiling.
/// </summary>
/// <remarks>
/// The declaration and its application are split on purpose: metadata is attached at route
/// registration, and <see cref="RequestBodyLimitMiddleware"/> applies it to the connection before
/// any handler reads the body. An endpoint filter cannot do this job - filters run after minimal
/// API parameter binding, which is when the body has already been read and copied.
/// </remarks>
public sealed class RequestBodyLimitMetadata
{
    /// <summary>Initializes a new instance of the <see cref="RequestBodyLimitMetadata"/> class.</summary>
    /// <param name="maxRequestBodyBytes">The largest request body the route accepts, in bytes.</param>
    public RequestBodyLimitMetadata(long maxRequestBodyBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxRequestBodyBytes);
        MaxRequestBodyBytes = maxRequestBodyBytes;
    }

    /// <summary>The largest request body the route accepts, in bytes.</summary>
    public long MaxRequestBodyBytes { get; }
}
