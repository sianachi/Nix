using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Api.Errors;
using Nix.Application.Identity;
using Nix.Application.Persistence;
using Nix.Core.Identity;
using Nix.Infrastructure.Persistence;

namespace Nix.Api.Authentication;

/// <summary>
/// Turns a bearer token into a tenant-scoped unit of work, and commits it if the request succeeds.
/// </summary>
/// <remarks>
/// <para>
/// This is the seam the whole persistence design assumes and nothing previously provided. Five
/// things have to happen in order, and every one of them is load-bearing:
/// </para>
/// <list type="number">
///   <item><description>the token validates against the issuer its tenant registered;</description></item>
///   <item><description>the subject resolves to a provisioned principal;</description></item>
///   <item><description>that principal is still allowed to act - checked per request, not per sign-in;</description></item>
///   <item><description>the session context is established, once, for this scope;</description></item>
///   <item><description>a transaction is opened, which is where the interceptor publishes <c>SET LOCAL</c>.</description></item>
/// </list>
/// <para>
/// <b>Why a transaction wraps every request, including reads.</b> The tenant scope is
/// transaction-local by construction: <c>SET LOCAL</c> has no meaning outside one, and the
/// alternative - a session-scoped <c>SET</c> - leaks the tenant onto a pooled connection for
/// whoever leases it next. So a request without a transaction is a request with no tenant, which
/// row-level security answers with nothing.
/// </para>
/// <para>
/// <b>Commit only on success.</b> Anything that leaves the pipeline with a failure status, or by
/// throwing, rolls back. A write that half-happened alongside a 500 is worse than one that did not
/// happen, particularly where the write maintains a derived table.
/// </para>
/// </remarks>
[SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    // Justification: activated by UseMiddleware. The analyser sees no `new`, because there is none to see - the
    // container builds it. Making it public to dodge the rule would widen the assembly's surface
    // for a diagnostic that is simply wrong here.
    Justification = "Constructed by the framework, not by application code.")]
internal sealed class NixUnitOfWorkMiddleware
{
    /// <summary>Stable code for a request with no usable credentials.</summary>
    internal const string UnauthenticatedCode = "auth.unauthenticated";

    /// <summary>Stable code for a principal who exists but may no longer act.</summary>
    internal const string PrincipalInactiveCode = "auth.principal_inactive";

    private readonly RequestDelegate _next;

    /// <summary>Initializes a new instance of the <see cref="NixUnitOfWorkMiddleware"/> class.</summary>
    /// <param name="next">The rest of the pipeline.</param>
    public NixUnitOfWorkMiddleware(RequestDelegate next)
    {
        ArgumentNullException.ThrowIfNull(next);
        _next = next;
    }

    /// <summary>Runs the request inside a tenant-scoped unit of work.</summary>
    /// <param name="context">The request.</param>
    /// <param name="validator">Validates the bearer token.</param>
    /// <param name="directory">Resolves the principal behind it.</param>
    /// <param name="accessor">Where the session context is written, once per scope.</param>
    /// <param name="dbContext">The context whose transaction carries the scope.</param>
    /// <returns>A task that completes when the request has been handled.</returns>
    public async Task InvokeAsync(
        HttpContext context,
        NixTokenValidator validator,
        IIdentityDirectory directory,
        ScopedNixSessionContextAccessor accessor,
        NixDbContext dbContext)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(validator);
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(accessor);
        ArgumentNullException.ThrowIfNull(dbContext);

        var token = ReadBearerToken(context.Request);
        if (token is null)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "This endpoint requires a bearer token issued by a registered identity provider.")
                .ConfigureAwait(false);
            return;
        }

        var validated = await validator.ValidateAsync(token, context.RequestAborted).ConfigureAwait(false);
        if (validated is null)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "The token could not be validated against a registered issuer.")
                .ConfigureAwait(false);
            return;
        }

        var principal = await directory
            .FindPrincipalAsync(validated.Registration.TenantId, validated.Subject, context.RequestAborted)
            .ConfigureAwait(false);

        if (principal is null)
        {
            // A valid token for a subject nobody provisioned. Refused, and never used to create
            // one: provisioning is SCIM's job, and a token alone must not mint an identity.
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "The token's subject is not provisioned in this tenant.")
                .ConfigureAwait(false);
            return;
        }

        if (principal.Status != PrincipalStatus.Active)
        {
            // Checked on every request rather than at sign-in, because an access token outlives the
            // decision to revoke it. This is what makes deprovisioning take effect immediately
            // instead of whenever the current token happens to expire.
            await WriteProblemAsync(
                context,
                StatusCodes.Status403Forbidden,
                PrincipalInactiveCode,
                "Account is not active",
                "This account has been suspended or deprovisioned.")
                .ConfigureAwait(false);
            return;
        }

        accessor.Set(NixSessionContext.ForTenant(principal.TenantId, principal.Id));

        var transaction = await dbContext.Database
            .BeginTransactionAsync(context.RequestAborted)
            .ConfigureAwait(false);

        await using (transaction.ConfigureAwait(false))
        {
            await _next(context).ConfigureAwait(false);

            if (context.Response.StatusCode >= StatusCodes.Status400BadRequest)
            {
                await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                return;
            }

            await transaction.CommitAsync(context.RequestAborted).ConfigureAwait(false);
        }
    }

    private static string? ReadBearerToken(HttpRequest request)
    {
        const string prefix = "Bearer ";
        var header = request.Headers.Authorization.ToString();

        return header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? header[prefix.Length..].Trim()
            : null;
    }

    private static async Task WriteProblemAsync(
        HttpContext context,
        int status,
        string code,
        string title,
        string detail)
    {
        var problem = ApiProblem.Create(context, status, code, title, detail);
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/problem+json";
        await context.Response.WriteAsJsonAsync(problem, context.RequestAborted).ConfigureAwait(false);
    }
}
