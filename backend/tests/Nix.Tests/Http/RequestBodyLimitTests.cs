using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Nix.Http;

namespace Nix.Tests.Http;

/// <summary>
/// A route's declared body bound reaches the connection before anything reads the body.
/// </summary>
/// <remarks>
/// Tested against the middleware and the convention directly: the in-memory TestServer does not
/// enforce <c>IHttpMaxRequestBodySizeFeature</c> the way Kestrel does, so an end-to-end oversized
/// request would pass whatever the limit said. What is provable here is that the limit is set on
/// the feature Kestrel honors, and <c>EndpointHardeningTests</c> proves the routes declare it.
/// </remarks>
public sealed class RequestBodyLimitTests
{
    [Fact]
    public async Task A_declared_limit_is_applied_to_the_connection_before_the_endpoint_runs()
    {
        long? limitWhenEndpointRan = null;
        var feature = new WritableBodySizeFeature();
        var context = ContextFor(feature, endpointLimitBytes: 2048);

        await Middleware(c =>
        {
            limitWhenEndpointRan = c.Features.GetRequiredFeature<IHttpMaxRequestBodySizeFeature>().MaxRequestBodySize;
            return Task.CompletedTask;
        }).InvokeAsync(context);

        Assert.Equal(2048, limitWhenEndpointRan);
        Assert.Equal(2048, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task An_endpoint_without_a_declared_limit_keeps_the_host_wide_bound()
    {
        var feature = new WritableBodySizeFeature();
        var context = ContextFor(feature, endpointLimitBytes: null);

        await Middleware(_ => Task.CompletedTask).InvokeAsync(context);

        Assert.Equal(256 * 1024, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task A_read_only_feature_is_left_alone_and_the_request_still_runs()
    {
        var ran = false;
        var feature = new WritableBodySizeFeature { IsReadOnly = true };
        var context = ContextFor(feature, endpointLimitBytes: 2048);

        await Middleware(_ =>
        {
            ran = true;
            return Task.CompletedTask;
        }).InvokeAsync(context);

        Assert.True(ran);
        Assert.Equal(256 * 1024, feature.MaxRequestBodySize);
    }

    [Fact]
    public void Declaring_a_limit_attaches_metadata_carrying_the_byte_count()
    {
        var collector = new ConventionCollector();

        collector.WithRequestBodyLimit(2 * 1024 * 1024);

        var endpointBuilder = new RouteEndpointBuilder(
            requestDelegate: null,
            RoutePatternFactory.Parse("/probe"),
            order: 0);
        foreach (var convention in collector.Conventions)
        {
            convention(endpointBuilder);
        }

        var metadata = Assert.Single(endpointBuilder.Metadata.OfType<RequestBodyLimitMetadata>());
        Assert.Equal(2 * 1024 * 1024, metadata.MaxRequestBodyBytes);
    }

    [Fact]
    public void A_zero_or_negative_limit_is_a_bug_and_refused_at_declaration()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new RequestBodyLimitMetadata(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => new RequestBodyLimitMetadata(-1));
    }

    private static RequestBodyLimitMiddleware Middleware(RequestDelegate next) => new(next);

    private static DefaultHttpContext ContextFor(
        WritableBodySizeFeature feature,
        long? endpointLimitBytes)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        var metadata = endpointLimitBytes is { } bytes
            ? new EndpointMetadataCollection(new RequestBodyLimitMetadata(bytes))
            : EndpointMetadataCollection.Empty;
        context.SetEndpoint(new Endpoint(_ => Task.CompletedTask, metadata, "probe"));

        return context;
    }

    /// <summary>Stands in for Kestrel's feature; starts at the host-wide 256 KB bound.</summary>
    private sealed class WritableBodySizeFeature : IHttpMaxRequestBodySizeFeature
    {
        public bool IsReadOnly { get; init; }

        public long? MaxRequestBodySize { get; set; } = 256 * 1024;
    }

    private sealed class ConventionCollector : IEndpointConventionBuilder
    {
        public List<Action<EndpointBuilder>> Conventions { get; } = [];

        public void Add(Action<EndpointBuilder> convention) => Conventions.Add(convention);
    }
}
