namespace Nix.Http;

/// <summary>Route-scoped request-body bounds for endpoints whose legitimate payloads exceed the global cap.</summary>
public static class RequestBodyLimitExtensions
{
    /// <summary>
    /// Declares the largest request body the route accepts, overriding the host-wide Kestrel
    /// ceiling for this one endpoint.
    /// </summary>
    /// <typeparam name="TBuilder">The convention builder being extended.</typeparam>
    /// <param name="builder">The route being registered.</param>
    /// <param name="maxRequestBodyBytes">The bound, in bytes.</param>
    /// <returns><paramref name="builder"/>, for chaining.</returns>
    public static TBuilder WithRequestBodyLimit<TBuilder>(this TBuilder builder, long maxRequestBodyBytes)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.Add(endpoint => endpoint.Metadata.Add(new RequestBodyLimitMetadata(maxRequestBodyBytes)));
        return builder;
    }
}
