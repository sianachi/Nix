using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Http;
using Nix.Persistence;

namespace Nix.Tests.Http;

public sealed class InternalWriteRateLimiterTests
{
    [Fact]
    public async Task Authenticated_tenants_and_principals_have_isolated_internal_write_buckets()
    {
        using var limiter = new InternalWriteRateLimiter(1, TimeSpan.FromMinutes(1));
        var calls = 0;
        var middleware = new InternalWriteRateLimitMiddleware(_ =>
        {
            calls++;
            return Task.CompletedTask;
        });
        var tenantOne = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var tenantTwo = TenantId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        var principalOne = PrincipalId.From(Guid.Parse("33333333-3333-4333-8333-333333333333"));
        var principalTwo = PrincipalId.From(Guid.Parse("44444444-4444-4444-8444-444444444444"));

        Assert.Equal(StatusCodes.Status200OK, await InvokeAsync(
            middleware,
            limiter,
            NixSessionContext.ForTenant(tenantOne, principalOne),
            "Bearer first"));
        Assert.Equal(StatusCodes.Status429TooManyRequests, await InvokeAsync(
            middleware,
            limiter,
            NixSessionContext.ForTenant(tenantOne, principalOne),
            "Bearer attacker-chosen-different-token"));
        Assert.Equal(StatusCodes.Status200OK, await InvokeAsync(
            middleware,
            limiter,
            NixSessionContext.ForTenant(tenantTwo, principalOne),
            "Bearer second-tenant"));
        Assert.Equal(StatusCodes.Status200OK, await InvokeAsync(
            middleware,
            limiter,
            NixSessionContext.ForTenant(tenantOne, principalTwo),
            "Bearer second-principal"));
        Assert.Equal(3, calls);
    }

    private static async Task<int> InvokeAsync(
        InternalWriteRateLimitMiddleware middleware,
        InternalWriteRateLimiter limiter,
        NixSessionContext session,
        string authorization)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.Headers.Authorization = authorization;
        context.Response.Body = new MemoryStream();
        var accessor = new ScopedNixSessionContextAccessor();
        accessor.Set(session);

        await middleware.InvokeAsync(
            context,
            accessor,
            limiter,
            NullLogger<InternalWriteRateLimitMiddleware>.Instance);
        return context.Response.StatusCode;
    }
}
