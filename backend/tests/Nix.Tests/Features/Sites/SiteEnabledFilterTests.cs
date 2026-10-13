using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.DependencyInjection;
using Nix.Features.Sites;

namespace Nix.Tests.Features.Sites;

public sealed class SiteEnabledFilterTests
{
    [Fact]
    public async Task A_disabled_deployment_refuses_every_sites_route_with_not_configured()
    {
        var context = ContextWith(new SiteOptions { Domain = "sites.example.net" });
        var reached = false;

        var result = await SiteGate.RequireEnabled(context, _ =>
        {
            reached = true;
            return ValueTask.FromResult<object?>(Results.Ok());
        });

        Assert.False(reached);
        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, problem.StatusCode);
        Assert.Equal(SiteErrors.NotConfiguredCode, problem.ProblemDetails.Extensions["code"]?.ToString());
    }

    [Fact]
    public async Task An_enabled_deployment_lets_the_route_run()
    {
        var context = ContextWith(new SiteOptions { Enabled = true, Domain = "sites.example.net" });

        var result = await SiteGate.RequireEnabled(context, _ => ValueTask.FromResult<object?>("ran"));

        Assert.Equal("ran", result);
    }

    private static DefaultEndpointFilterInvocationContext ContextWith(SiteOptions options)
    {
        var services = new ServiceCollection().AddSingleton(options).BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Request.Path = "/api/v1/sites";
        return new DefaultEndpointFilterInvocationContext(http);
    }
}
