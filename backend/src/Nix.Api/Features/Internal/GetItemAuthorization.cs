using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Internal;

/// <summary>
/// Asks, on behalf of the collaboration service, what the acting principal may do with one item.
/// </summary>
/// <param name="ItemId">The item whose body the caller wants to open.</param>
/// <remarks>
/// The collaboration service holds a live session open for minutes, not milliseconds, and it needs
/// one answer at the handshake instead of two public-API round trips per update: may this
/// principal read the item, may they write it, and which body kind the item carries. The acting
/// principal comes from the forwarded user token the unit-of-work middleware validated, never from
/// a parameter - the internal boundary proves the caller is the collaboration service, and the
/// token proves on whose behalf it asks.
/// </remarks>
public sealed record GetItemAuthorization(ItemId ItemId) : IQuery<Result<ItemAuthorization>>;

/// <summary>Resolves an item authorization for the collaboration service.</summary>
/// <remarks>
/// An item the principal may not read is a failure, never a "canRead: false" payload: reporting
/// "you may not see this" confirms the item exists, which is how an outsider enumerates a
/// workspace one identifier at a time. A 200 from this endpoint therefore always means readable,
/// and <see cref="ItemAuthorization.CanWrite"/> is the only permission that varies. Write access
/// is workspace-grained today because that is what <see cref="IPermissionResolver"/> answers; when
/// item-level entries arrive the resolver's implementation changes and this handler does not.
/// </remarks>
public sealed class GetItemAuthorizationHandler : IQueryHandler<GetItemAuthorization, Result<ItemAuthorization>>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly AccessTokenSessionContext _scope;

    /// <summary>Initializes a new instance of the <see cref="GetItemAuthorizationHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the acting principal may do.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="scope">The scope ceiling, when a personal access token authenticated the call.</param>
    public GetItemAuthorizationHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        AccessTokenSessionContext scope)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(scope);

        _tree = tree;
        _permissions = permissions;
        _session = session;
        _scope = scope;
    }

    /// <summary>Resolves the authorization.</summary>
    /// <param name="query">The item to answer for.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The authorization, or why none could be given.</returns>
    public async ValueTask<Result<ItemAuthorization>> HandleAsync(
        GetItemAuthorization query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<ItemAuthorization>(
                InternalErrors.NotFound($"No item {query.ItemId} is visible."));
        }

        var mayRead = await _permissions
            .CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        if (!mayRead)
        {
            return Result.Failure<ItemAuthorization>(
                InternalErrors.NotFound($"No item {query.ItemId} is visible."));
        }

        var mayWrite = await _permissions
            .CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);

        // The collaboration service writes bodies on the strength of this answer and never asks
        // Core again, so the acting credential's ceiling has to be folded in here rather than only
        // at the route the caller reached. A read-only personal access token authenticates this
        // GET legitimately; intersecting with its ceiling is what stops it from writing through
        // the service that trusts CanWrite. An interactive session leaves the ceiling permissive.
        var mayWriteWithinScope = mayWrite && _scope.MayWrite;

        return Result.Success(
            new ItemAuthorization(
                context.TenantId,
                context.PrincipalId,
                item.WorkspaceId,
                CanWrite: mayWriteWithinScope,
                BodyKind: item.Type));
    }
}

/// <summary>What the acting principal may do with an item, answered once per session.</summary>
/// <param name="TenantId">The tenant the principal is acting in.</param>
/// <param name="PrincipalId">The acting principal.</param>
/// <param name="WorkspaceId">The workspace the item lives in.</param>
/// <param name="CanWrite">Whether the principal may append updates to the item's body.</param>
/// <param name="BodyKind">
/// The item's <c>type</c> - how its own body is drawn, which is what the collaboration service
/// dispatches validation on. An open string by design (ADR-0009); consumers treat unknown kinds
/// as the default prose body rather than refusing them.
/// </param>
public sealed record ItemAuthorization(
    TenantId TenantId,
    PrincipalId PrincipalId,
    WorkspaceId WorkspaceId,
    bool CanWrite,
    string BodyKind);

/// <summary>
/// Route handler for the collaboration service's authorization question.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetItemAuthorization"/> itself: the query record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapGet</c> call site.
/// </remarks>
internal static class GetItemAuthorizationEndpoint
{
    /// <summary>Handles an authorization question for one item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The authorization, or a problem describing why none could be given.</returns>
    internal static async Task<Results<Ok<ItemAuthorizationResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ItemAuthorizationResponse>, ProblemHttpResult>>(
            authorization => TypedResults.Ok(
                new ItemAuthorizationResponse(
                    authorization.TenantId.Value,
                    authorization.PrincipalId.Value,
                    authorization.WorkspaceId.Value,
                    CanRead: true,
                    authorization.CanWrite,
                    authorization.BodyKind)),
            error => TypedResults.Problem(InternalEndpoints.Problem(httpContext, error)));
    }
}
