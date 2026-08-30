using System.Diagnostics.CodeAnalysis;
using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence;

namespace Nix.Authentication;

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
    internal const string UnauthenticatedCode = AuthenticationRefusalCodes.Unauthenticated;

    /// <summary>Stable code for a principal who exists but may no longer act.</summary>
    internal const string PrincipalInactiveCode = AuthenticationRefusalCodes.PrincipalInactive;

    /// <summary>Stable code for a session whose access token has been revoked or deleted.</summary>
    internal const string TokenRevokedCode = AuthenticationRefusalCodes.TokenRevoked;

    /// <summary>Stable code for a session whose access token has passed its chosen expiry.</summary>
    internal const string TokenExpiredCode = AuthenticationRefusalCodes.TokenExpired;

    /// <summary>Stable code for a token that stands but does not reach this route.</summary>
    internal const string InsufficientScopeCode = AuthenticationRefusalCodes.InsufficientScope;

    /// <summary>
    /// How stale <c>last_used_at</c> may be before authenticating writes it again. Coarse on
    /// purpose: the column answers "is anything still using this token", which does not need
    /// per-request precision, and a write per authenticated read would put an update on the
    /// hottest path in the system.
    /// </summary>
    private static readonly TimeSpan LastUsedGranularity = TimeSpan.FromMinutes(5);

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
    /// <param name="throttle">Counts failed validations per client, so guessing meets a 429.</param>
    /// <param name="accessTokens">Re-checks the token row behind a token-authenticated session.</param>
    /// <param name="clock">Judges token expiry and stamps last use.</param>
    /// <param name="logger">Where a refusal is recorded.</param>
    /// <returns>A task that completes when the request has been handled.</returns>
    public async Task InvokeAsync(
        HttpContext context,
        NixTokenValidator validator,
        IIdentityDirectory directory,
        ScopedNixSessionContextAccessor accessor,
        NixDbContext dbContext,
        FailedAuthenticationThrottle throttle,
        IPersonalAccessTokens accessTokens,
        AccessTokenSessionContext scopeContext,
        TimeProvider clock,
        ILogger<NixUnitOfWorkMiddleware> logger)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(validator);
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(accessor);
        ArgumentNullException.ThrowIfNull(dbContext);
        ArgumentNullException.ThrowIfNull(throttle);
        ArgumentNullException.ThrowIfNull(accessTokens);
        ArgumentNullException.ThrowIfNull(scopeContext);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(logger);

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

        // The throttle covers requests that present a token, because a presented token is a guess.
        // A request with no token at all took no shot at the oracle and keeps its plain 401 above,
        // so a misconfigured client that lost its token cannot throttle its own address into
        // opacity. Keyed by remote address: it is what a pre-authentication surface has, and the
        // limit is generous enough that people behind one NAT retrying honest failures never meet
        // it. That address is the originating client's only because UseForwardedHeaders runs first
        // and rewrites it from a trusted proxy's X-Forwarded-For; without that, every request
        // behind the proxy shares one window and this throttle is global. Checked before
        // validating, so a client already over the limit costs no signature verification.
        var clientKey = ClientKey.For(context);
        if (throttle.IsThrottled(clientKey, out var retryAfter))
        {
            // Information, not Warning: the crossing was already logged at Warning below, and the
            // refusals that follow it are the same fact repeated once per request in the scan.
            await RateLimitRefusal.WriteAsync(
                context,
                logger,
                RateLimitRefusal.FailedAuthenticationLimiterName,
                retryAfter,
                LogLevel.Information,
                context.RequestAborted).ConfigureAwait(false);
            return;
        }

        var validated = await validator.ValidateAsync(token, context.RequestAborted).ConfigureAwait(false);
        if (validated is null)
        {
            RecordFailure(throttle, logger, context, clientKey);
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "The token could not be validated against a registered issuer.")
                .ConfigureAwait(false);
            return;
        }

        var principal = validated switch
        {
            ValidatedCoreToken core => await directory.FindPrincipalByIdAsync(
                core.TenantId,
                core.PrincipalId,
                context.RequestAborted).ConfigureAwait(false),
            ValidatedExternalToken external => await directory.FindExternalPrincipalAsync(
                external.TenantId,
                external.Registration.Issuer,
                external.Subject,
                context.RequestAborted).ConfigureAwait(false),
            _ => throw new InvalidOperationException("Unknown validated token kind."),
        };

        if (principal is null)
        {
            // A valid token for a subject nobody provisioned. This lookup never creates one: the
            // dedicated JIT path may do so only for an exact authorized-party registration whose
            // stored policy enables it. A token alone must never mint an identity. The miss also
            // counts against the throttle - enumerating subjects is a guessing loop too.
            RecordFailure(throttle, logger, context, clientKey);
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
            // A token-authenticated session re-checks its row on every request, inside the
            // transaction that just published the tenant scope. This is what makes revocation
            // immediate rather than "when the ten-minute JWT runs out", and it is where the
            // scope ceiling is applied - before the endpoint, after the transaction, so a
            // refused request rolls back like any other failure.
            if (validated is ValidatedCoreToken core)
            {
                var admitted = await EnforceAccessTokenAsync(
                    context,
                    accessTokens,
                    scopeContext,
                    clock,
                    core.AccessTokenId,
                    principal.Id)
                    .ConfigureAwait(false);

                if (!admitted)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    return;
                }
            }

            await _next(context).ConfigureAwait(false);

            if (context.Response.StatusCode >= StatusCodes.Status400BadRequest)
            {
                await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                return;
            }

            await transaction.CommitAsync(context.RequestAborted).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Re-judges a token-authenticated session against its row: standing, unexpired, held by the
    /// resolved principal, and scoped to reach this route.
    /// </summary>
    /// <param name="context">The current request.</param>
    /// <param name="accessTokens">Reads and touches the row.</param>
    /// <param name="clock">Judges expiry and stamps last use.</param>
    /// <param name="accessTokenId">The row the validated JWT names.</param>
    /// <param name="principalId">The principal the session resolved to.</param>
    /// <returns>Whether the request may proceed. A refusal has already been written.</returns>
    private static async Task<bool> EnforceAccessTokenAsync(
        HttpContext context,
        IPersonalAccessTokens accessTokens,
        AccessTokenSessionContext scopeContext,
        TimeProvider clock,
        PersonalAccessTokenId accessTokenId,
        PrincipalId principalId)
    {
        var state = await accessTokens
            .FindSessionStateAsync(accessTokenId, context.RequestAborted)
            .ConfigureAwait(false);

        // A deleted row and a row belonging to a different principal answer identically: the JWT
        // is signed by us and both claims came from one mint, so a mismatch is a defect or a
        // forgery, and neither deserves a more detailed answer than "this token no longer works".
        if (state is null || state.PrincipalId != principalId)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenRevokedCode,
                "Access token no longer valid",
                $"Personal access token '{accessTokenId}' no longer authenticates requests. "
                + "Issue a new token from your settings.")
                .ConfigureAwait(false);
            return false;
        }

        if (state.RevokedAt is { } revokedAt)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenRevokedCode,
                "Access token revoked",
                $"Personal access token '{accessTokenId}' was revoked at {revokedAt:O}.")
                .ConfigureAwait(false);
            return false;
        }

        var now = clock.GetUtcNow();
        if (state.ExpiresAt <= now)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenExpiredCode,
                "Access token expired",
                $"Personal access token '{accessTokenId}' expired at {state.ExpiresAt:O}.")
                .ConfigureAwait(false);
            return false;
        }

        var requirement = AccessTokenScopePolicy.Classify(context.Request.Method, context.Request.Path);
        if (!AccessTokenScopePolicy.Satisfies(state.Scopes, requirement))
        {
            // 403, not 401: the session authenticated. The detail names the principal their own
            // identity and the scope the route wanted, which is the honest refusal MVP-9.4 asks
            // for and discloses nothing the caller does not already hold.
            await WriteProblemAsync(
                context,
                StatusCodes.Status403Forbidden,
                InsufficientScopeCode,
                "Access token out of scope",
                $"Principal '{principalId}' is authenticated, but personal access token "
                + $"'{accessTokenId}' does not reach {context.Request.Method} "
                + $"{context.Request.Path}: it requires {AccessTokenScopePolicy.Describe(requirement)}.")
                .ConfigureAwait(false);
            return false;
        }

        // Record the ceiling for the surfaces Core reports about rather than acts for. The
        // route-level check above closed every endpoint Core owns; this is what carries the same
        // ceiling into GetItemAuthorization's CanWrite, so a read-only token cannot have the
        // collaboration service write a body on its behalf.
        scopeContext.SetTokenCeiling(
            mayWrite: AccessTokenScopePolicy.Satisfies(state.Scopes, AccessTokenScopePolicy.Requirement.Write),
            mayAdminister: AccessTokenScopePolicy.Satisfies(state.Scopes, AccessTokenScopePolicy.Requirement.Admin));

        if (state.LastUsedAt is null || now - state.LastUsedAt >= LastUsedGranularity)
        {
            await accessTokens.TouchAsync(accessTokenId, now, context.RequestAborted).ConfigureAwait(false);
        }

        return true;
    }

    private static void RecordFailure(
        FailedAuthenticationThrottle throttle,
        ILogger logger,
        HttpContext context,
        IPAddress clientKey)
    {
        if (!throttle.RecordFailure(clientKey))
        {
            return;
        }

        // The failure that reached the limit is still answered with a 401; what changes is that
        // every later request from this address is refused without a validation. That transition is
        // the operator-visible event, so it is logged once, here, at Warning.
        throttle.IsThrottled(clientKey, out var window);
        ApiLog.FailedAuthenticationLimitReached(
            logger,
            clientKey,
            context.Request.Path.Value ?? string.Empty,
            Math.Max(1L, (long)Math.Ceiling(window.TotalSeconds)));
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

        // The content type must ride the write call: the two-argument WriteAsJsonAsync overload
        // stamps application/json over anything set on the response beforehand.
        await context.Response
            .WriteAsJsonAsync(problem, options: null, "application/problem+json", context.RequestAborted)
            .ConfigureAwait(false);
    }
}
