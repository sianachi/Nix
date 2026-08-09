using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Errors;
using Nix.Http;

namespace Nix.Tests.Errors;

/// <summary>
/// The refusal shapes baseline hardening adds: an oversized body and a rate-limited client both
/// answer RFC 9457 problem details with a stable code.
/// </summary>
/// <remarks>
/// The 413 is asserted at the enrichment seam rather than end to end, because the in-memory
/// TestServer never enforces Kestrel's body limit, so no in-process request can make Kestrel
/// refuse one. What is provable without a socket is the contract: any 413 that reaches the
/// problem-details pipeline leaves with the stable code.
/// </remarks>
public sealed class HardeningProblemTests
{
    [Fact]
    public void A_413_problem_is_enriched_with_the_stable_body_too_large_code()
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status413PayloadTooLarge };

        ApiProblem.Enrich(problem, new DefaultHttpContext());

        Assert.Equal(ApiProblem.BodyTooLargeCode, problem.Extensions[ApiProblem.CodeExtension]);
        Assert.Equal("Request body too large", problem.Title);
    }

    [Fact]
    public void A_413_that_already_carries_a_feature_code_keeps_it()
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status413PayloadTooLarge };
        problem.Extensions[ApiProblem.CodeExtension] = "canvas_library.too_large";

        ApiProblem.Enrich(problem, new DefaultHttpContext());

        Assert.Equal("canvas_library.too_large", problem.Extensions[ApiProblem.CodeExtension]);
    }

    [Fact]
    public async Task A_rate_limited_refusal_is_problem_details_with_the_stable_code_and_a_retry_after_header()
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider(),
        };
        context.Request.Path = "/api/v1/items/00000000-0000-4000-8000-000000000000";
        context.Response.Body = new MemoryStream();

        await RateLimitRefusal.WriteAsync(
            context,
            NullLogger.Instance,
            RateLimitRefusal.WritesPolicyName,
            TimeSpan.FromSeconds(90),
            LogLevel.Information,
            TestContext.Current.CancellationToken);

        context.Response.Body.Position = 0;
        var body = await JsonNode.ParseAsync(
            context.Response.Body,
            cancellationToken: TestContext.Current.CancellationToken);

        Assert.Equal(StatusCodes.Status429TooManyRequests, context.Response.StatusCode);
        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("90", context.Response.Headers.RetryAfter.ToString());
        Assert.Equal("request.rate_limited", (string?)body?["code"]);
        Assert.Equal(429, (int?)body?["status"]);
        Assert.Equal("/api/v1/items/00000000-0000-4000-8000-000000000000", (string?)body?["instance"]);
    }

    [Fact]
    public async Task A_retry_after_below_one_second_is_reported_as_one_rather_than_zero()
    {
        // Retry-After: 0 invites an immediate retry, which is the loop the refusal exists to slow.
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider(),
        };
        context.Response.Body = new MemoryStream();

        await RateLimitRefusal.WriteAsync(
            context,
            NullLogger.Instance,
            RateLimitRefusal.WritesPolicyName,
            TimeSpan.FromMilliseconds(20),
            LogLevel.Information,
            TestContext.Current.CancellationToken);

        Assert.Equal("1", context.Response.Headers.RetryAfter.ToString());
    }

    [Fact]
    public async Task A_refusal_is_logged_with_the_limiter_the_client_and_what_it_was_told_to_wait()
    {
        // Without this line the only evidence a client is being refused is that client's own
        // report, which is not evidence an operator has at three in the morning.
        var logger = new RecordingLogger();
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider(),
        };
        context.Request.Path = "/api/v1/items";
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.5");
        context.Response.Body = new MemoryStream();

        await RateLimitRefusal.WriteAsync(
            context,
            logger,
            RateLimitRefusal.WritesPolicyName,
            TimeSpan.FromSeconds(30),
            LogLevel.Warning,
            TestContext.Current.CancellationToken);

        var (level, message) = Assert.Single(logger.Lines);
        Assert.Equal(LogLevel.Warning, level);
        Assert.Contains(RateLimitRefusal.WritesPolicyName, message, StringComparison.Ordinal);
        Assert.Contains("203.0.113.5", message, StringComparison.Ordinal);
        Assert.Contains("/api/v1/items", message, StringComparison.Ordinal);
        Assert.Contains("30", message, StringComparison.Ordinal);
    }

    private sealed class RecordingLogger : ILogger
    {
        public List<(LogLevel Level, string Message)> Lines { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            Lines.Add((logLevel, formatter(state, exception)));
        }
    }
}
