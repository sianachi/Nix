using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Authentication;
using Nix.Tests.Harness;

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

    [Theory]
    [InlineData(null)]
    [InlineData("short")]
    [InlineData("b-long-shared-secret-for-tests")]
    public async Task Missing_short_and_same_length_wrong_secrets_receive_the_uniform_refusal(string? presented)
    {
        var middleware = Middleware(ConfiguredSecret, NextMustNotRun);
        var context = ContextWithHeader(presented);

        await middleware.InvokeAsync(context);

        context.Response.Body.Position = 0;
        var body = await JsonNode.ParseAsync(
            context.Response.Body,
            cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("internal.not_found", (string?)body?["code"]);
        Assert.Equal("Not found", (string?)body?["title"]);
        Assert.Equal("The requested resource does not exist.", (string?)body?["detail"]);
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
public sealed class InternalSurfaceContractTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    /// <summary>
    /// The internal surface is absent from the contract clients are generated from.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Read from <c>backend/openapi/nix-api.json</c> rather than from the <c>/openapi/v1.json</c>
    /// route. That file is the contract of record - it is what <c>packages/api-client</c> generates
    /// from, and the route's own comment in <c>Program</c> says it exists for local exploration
    /// only. The route is also mapped exclusively in the Development environment, so asserting
    /// against it made this test require the host to be running as a developer's machine.
    /// </para>
    /// <para>
    /// Nothing is given up by the change: the backend build regenerates the committed document and
    /// CI fails on <c>git diff --exit-code -- backend/openapi</c>, so the file and the endpoint
    /// cannot disagree.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_internal_surface_is_absent_from_the_openapi_document()
    {
        var contract = PublishedContract.Path();

        var document = await File.ReadAllTextAsync(contract, TestContext.Current.CancellationToken);
        var paths = JsonNode.Parse(document)?["paths"]?.AsObject()
            ?? throw new InvalidOperationException($"The OpenAPI document at {contract} has no paths object.");

        Assert.DoesNotContain(paths, path => path.Key.StartsWith("/internal", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Template_metadata_has_no_direct_public_patch_bypass()
    {
        var document = await File.ReadAllTextAsync(
            PublishedContract.Path(),
            TestContext.Current.CancellationToken);
        var templatePath = JsonNode.Parse(document)?["paths"]?["/api/v1/templates/{templateId}"]?.AsObject()
            ?? throw new InvalidOperationException("The published template resource path is missing.");

        Assert.False(templatePath.ContainsKey("patch"));
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
