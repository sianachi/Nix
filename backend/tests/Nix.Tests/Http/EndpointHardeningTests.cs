using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Http;
using Nix.Tests.Harness;

namespace Nix.Tests.Http;

/// <summary>
/// Every route that mutates state carries the writes rate-limit policy, and the one route with a
/// legitimately large payload declares its own body bound - proven against the real application's
/// route table, so a new mutating endpoint registered without the policy fails here rather than
/// shipping unlimited.
/// </summary>
public sealed class EndpointHardeningTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    private static readonly string[] MutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];

    [Fact]
    public void Every_mutating_endpoint_requires_its_expected_rate_limit_policy()
    {
        var unlimited = MutatingEndpoints()
            .Where(endpoint => !IsInternal(endpoint))
            .Where(endpoint => endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName
                != ExpectedPolicy(endpoint.RoutePattern.RawText))
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(unlimited);
    }

    [Fact]
    public void Internal_mutations_do_not_use_the_pre_authentication_address_partition()
    {
        var addressPartitioned = MutatingEndpoints()
            .Where(IsInternal)
            .Where(endpoint => endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>() is not null)
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(addressPartitioned);
    }

    [Fact]
    public void The_canvas_library_put_declares_its_two_mebibyte_body_bound()
    {
        var endpoint = Assert.Single(
            MutatingEndpoints(),
            e => e.RoutePattern.RawText == "/api/v1/me/canvas-library");

        var declared = endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>();

        Assert.NotNull(declared);
        Assert.Equal(2 * 1024 * 1024, declared.MaxRequestBodyBytes);
    }

    [Fact]
    public void No_read_endpoint_declares_a_raised_body_bound()
    {
        // A raised bound on a GET would say some read expects a body, which none does; the raise
        // exists solely for the canvas library replacement.
        var raisedReads = Routes()
            .Where(endpoint => !IsMutating(endpoint))
            .Where(endpoint => endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>() is not null)
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(raisedReads);
    }

    /// <summary>
    /// The policy each mutating route is expected to carry. The two unauthenticated public
    /// surfaces carry their own windows; every other mutation shares the writes policy.
    /// </summary>
    private static string ExpectedPolicy(string? routePattern) => routePattern switch
    {
        "/public/v1/forms/{token}" => RateLimitRefusal.PublicFormsPolicyName,
        "/public/v1/auth/token" => RateLimitRefusal.TokenExchangePolicyName,
        _ => RateLimitRefusal.WritesPolicyName,
    };

    private List<RouteEndpoint> MutatingEndpoints() =>
        [.. Routes().Where(IsMutating)];

    private List<RouteEndpoint> Routes() =>
        [.. factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()];

    private static bool IsMutating(RouteEndpoint endpoint)
    {
        var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        return methods is not null && methods.Any(MutatingMethods.Contains);
    }

    private static bool IsInternal(RouteEndpoint endpoint) =>
        endpoint.RoutePattern.RawText?.StartsWith("/internal", StringComparison.Ordinal) is true;
}
