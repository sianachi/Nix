using System.Diagnostics;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Locks;

/// <summary>
/// Route registration for item locks: a password an item's body is held behind.
/// </summary>
/// <remarks>
/// <para>
/// <b>A lock withholds the body, it does not encrypt it.</b> The descriptions below say so where a
/// client could be tempted to promise more.
/// </para>
/// <para>
/// The routes that check a password carry their own, tighter rate limit in place of the writes
/// policy, partitioned by address: every check is a deliberately expensive derivation, so what one
/// client may ask for is bounded in total rather than per item.
/// </para>
/// </remarks>
internal static class LockEndpoints
{
    /// <summary>Registers the item-lock routes on <paramref name="endpoints"/>.</summary>
    internal static IEndpointRouteBuilder MapLockEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Item locks");

        items.MapGet("/{itemId:guid}/lock", GetItemLockEndpoint.Handle)
            .WithName("GetItemLock")
            .WithSummary("Whether an item's body is locked, and whether this session has it open")
            .WithDescription(
                "Returns whether the item's body is behind a password and, when it is, until when "
                + "the calling browser session or access token has it unlocked. A lock withholds "
                + "the body from anybody who has not unlocked it; it does not encrypt what is stored.")
            .Produces<ItemLockResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPut("/{itemId:guid}/lock", SetItemLockEndpoint.Handle)
            .WithName("SetItemLock")
            .WithSummary("Lock an item's body behind a password, or change the password")
            .WithDescription(
                "Locks the item's body, which needs write access. When the item is already locked "
                + "this changes the password instead, which also needs 'currentPassword' and ends "
                + "every other session's unlock. The calling session is left unlocked. Fails with "
                + "'locks.already_locked' when the item is locked and no current password is given, "
                + "'locks.wrong_password' when it does not match, and 'locks.password_invalid' when "
                + "the new password is too short or too long.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        items.MapPost("/{itemId:guid}/lock/remove", RemoveItemLockEndpoint.Handle)
            .WithName("RemoveItemLock")
            .WithSummary("Remove an item's lock")
            .WithDescription(
                "Removes the lock, which needs write access and the password. A POST with a body "
                + "rather than a DELETE, because the password must not travel in a URL.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        items.MapPost("/{itemId:guid}/unlock", UnlockItemEndpoint.Handle)
            .WithName("UnlockItem")
            .WithSummary("Open a locked item's body to this session for a while")
            .WithDescription(
                "Checks the password and opens the item's body to the calling browser session or "
                + "access token for fifteen minutes. Other sessions, including the caller's own "
                + "elsewhere, stay locked.")
            .Produces<UnlockItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        items.MapDelete("/{itemId:guid}/unlock", RelockItemEndpoint.Handle)
            .WithName("RelockItem")
            .WithSummary("Close a locked item's body to this session again")
            .WithDescription(
                "Ends the calling session's unlock before it runs out. Idempotent: relocking an "
                + "item that is not unlocked, or not locked, succeeds.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>Maps a lock failure to problem details: the code decides the status.</summary>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            LockErrors.PasswordInvalidCode => StatusCodes.Status400BadRequest,
            LockErrors.WrongPasswordCode or LockErrors.CredentialCannotUnlockCode =>
                StatusCodes.Status403Forbidden,
            LockErrors.AlreadyLockedCode or LockErrors.NotLockedCode => StatusCodes.Status409Conflict,
            LockErrors.TooManyAttemptsCode => StatusCodes.Status429TooManyRequests,
            LockErrors.BusyCode => StatusCodes.Status503ServiceUnavailable,
            LockErrors.NotFoundCode => StatusCodes.Status404NotFound,
            _ => throw new UnreachableException($"Lock error code '{error.Code}' has no status."),
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}

/// <summary>Route handler for reading a lock.</summary>
internal static class GetItemLockEndpoint
{
    internal static async Task<Results<Ok<ItemLockResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .QueryAsync<GetItemLock, Result<ItemLockState>>(
                new GetItemLock(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(LockEndpoints.Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(new ItemLockResponse(result.Value.Locked, result.Value.UnlockedUntil));
    }
}

/// <summary>Route handler for setting or changing a lock.</summary>
internal static class SetItemLockEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        SetItemLockRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<LockItem, bool>(
                new LockItem(ItemId.From(itemId), request.Password, request.CurrentPassword),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(LockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}

/// <summary>Route handler for removing a lock.</summary>
internal static class RemoveItemLockEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        ItemLockPasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<RemoveItemLock, bool>(
                new RemoveItemLock(ItemId.From(itemId), request.Password),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(LockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}

/// <summary>Route handler for unlocking.</summary>
internal static class UnlockItemEndpoint
{
    internal static async Task<Results<Ok<UnlockItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        ItemLockPasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<UnlockItem, DateTimeOffset>(
                new UnlockItem(ItemId.From(itemId), request.Password),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(LockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.Ok(new UnlockItemResponse(result.Value));
    }
}

/// <summary>Route handler for relocking.</summary>
internal static class RelockItemEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<RelockItem, bool>(
                new RelockItem(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(LockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}
