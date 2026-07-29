using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Authentication;

namespace Nix.Tests.Authentication;

/// <summary>
/// The internal boundary refuses everything it cannot prove came from a trusted service, and it
/// refuses in a way that does not admit the surface exists.
/// </summary>
public sealed class InternalBoundaryTests
{
    private const string ConfiguredSecret = "a-long-shared-secret-for-tests";

    [Fact]
    public async Task A_request_with_the_configured_secret_passes_the_boundary()
    {
        var reachedNext = false;
        var middleware = Middleware(ConfiguredSecret, _ =>
        {
            reachedNext = true;
            return Task.CompletedTask;
        });

        var context = ContextWithHeader(ConfiguredSecret);
        await middleware.InvokeAsync(context);

        Assert.True(reachedNext);
    }

    [Fact]
    public async Task A_request_without_the_header_is_answered_not_found()
    {
        var middleware = Middleware(ConfiguredSecret, NextMustNotRun);

        var context = ContextWithHeader(secret: null);
        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
    }

    [Fact]
    public async Task A_request_with_the_wrong_secret_is_answered_not_found()
    {
        var middleware = Middleware(ConfiguredSecret, NextMustNotRun);

        var context = ContextWithHeader("a-long-shared-secret-for-guessing");
        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
    }

    [Fact]
    public async Task An_unconfigured_secret_fails_closed_even_for_a_caller_presenting_one()
    {
        // A deployment that forgot to set the secret must refuse everything, not accept anything:
        // the alternative reading - "no secret configured" meaning "no secret required" - would
        // turn a missing environment variable into an open service-to-service surface.
        var middleware = Middleware(configuredSecret: null, NextMustNotRun);

        var context = ContextWithHeader("any-value-at-all");
        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
        Assert.False(middleware.Enabled);
    }

    [Fact]
    public async Task A_refusal_carries_the_stable_code_and_the_problem_shape()
    {
        var middleware = Middleware(ConfiguredSecret, NextMustNotRun);

        var context = ContextWithHeader(secret: null);
        await middleware.InvokeAsync(context);

        context.Response.Body.Position = 0;
        var body = await JsonNode.ParseAsync(
            context.Response.Body,
            cancellationToken: TestContext.Current.CancellationToken);

        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("internal.not_found", (string?)body?["code"]);
    }

    private static Task NextMustNotRun(HttpContext _) =>
        throw new InvalidOperationException("The boundary let a request through that it must refuse.");

    private static InternalBoundaryMiddleware Middleware(string? configuredSecret, RequestDelegate next)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(
                configuredSecret is null
                    ? []
                    : new Dictionary<string, string?>
                    {
                        [InternalBoundaryMiddleware.SecretConfigurationKey] = configuredSecret,
                    })
            .Build();

        return new InternalBoundaryMiddleware(next, configuration);
    }

    private static DefaultHttpContext ContextWithHeader(string? secret)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider(),
        };
        context.Request.Path = "/internal/authz/items/00000000-0000-4000-8000-000000000000";
        context.Response.Body = new MemoryStream();

        if (secret is not null)
        {
            context.Request.Headers[InternalBoundaryMiddleware.SecretHeaderName] = secret;
        }

        return context;
    }
}

/// <summary>
/// The internal surface stays out of the published contract and off the unauthenticated host,
/// proven through the real application rather than through the middleware in isolation.
/// </summary>
public sealed class InternalSurfaceContractTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task The_internal_surface_is_absent_from_the_openapi_document()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        var document = await client.GetStringAsync(
            new Uri("/openapi/v1.json", UriKind.Relative),
            cancellationToken);
        var paths = JsonNode.Parse(document)?["paths"]?.AsObject()
            ?? throw new InvalidOperationException("The OpenAPI document has no paths object.");

        Assert.DoesNotContain(paths, path => path.Key.StartsWith("/internal", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task A_host_without_a_configured_secret_answers_not_found_on_internal_routes()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            new Uri("/internal/authz/items/00000000-0000-4000-8000-000000000000", UriKind.Relative),
            cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("internal.not_found", body, StringComparison.Ordinal);
    }

}
