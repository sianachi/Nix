using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Persistence;

namespace Nix.Authentication;

/// <summary>Turns an exact live worker lease into a tenant-scoped unit of work.</summary>
/// <remarks>
/// The internal secret admits a process to the service boundary. This middleware provides the
/// narrower proof required for durable mutations: the request names the job and opaque execution
/// identity that currently owns its unexpired lease. The database resolves tenant and actor from
/// that authoritative row; neither value is accepted from a header or RabbitMQ payload.
/// </remarks>
public sealed class WorkerExecutionMiddleware
{
    /// <summary>Header naming the durable job.</summary>
    public const string JobHeaderName = "x-nix-worker-job-id";

    /// <summary>Header naming the current lease owner.</summary>
    public const string ExecutionHeaderName = "x-nix-worker-execution-id";

    private const string RefusalCode = "worker.execution_refused";
    private readonly RequestDelegate _next;

    /// <summary>Initializes the execution boundary.</summary>
    public WorkerExecutionMiddleware(RequestDelegate next)
    {
        ArgumentNullException.ThrowIfNull(next);
        _next = next;
    }

    /// <summary>Runs the request only while the exact execution owns a live lease.</summary>
    public async Task InvokeAsync(
        HttpContext context,
        IWorkerDispatchStore dispatch,
        ScopedNixSessionContextAccessor accessor,
        NixDbContext database)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(dispatch);
        ArgumentNullException.ThrowIfNull(accessor);
        ArgumentNullException.ThrowIfNull(database);

        var executionId = context.Request.Headers[ExecutionHeaderName].ToString();
        if (!Guid.TryParse(context.Request.Headers[JobHeaderName].ToString(), out var jobId)
            || string.IsNullOrWhiteSpace(executionId)
            || executionId.Length > 128)
        {
            await RefuseAsync(context).ConfigureAwait(false);
            return;
        }

        var authorization = await dispatch
            .AuthorizeExecutionAsync(jobId, executionId, context.RequestAborted)
            .ConfigureAwait(false);
        if (authorization is null)
        {
            await RefuseAsync(context).ConfigureAwait(false);
            return;
        }

        accessor.Set(new NixSessionContext(
            TenantId.From(authorization.TenantId),
            authorization.WorkspaceId is { } workspaceId ? WorkspaceId.From(workspaceId) : null,
            PrincipalId.From(authorization.ActorId)));

        var transaction = await database.Database
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

            // The endpoint may have taken long enough to lose its lease. Re-check before making
            // any mutation durable, so an abandoned execution cannot publish after its successor.
            if (await dispatch.AuthorizeExecutionAsync(jobId, executionId, context.RequestAborted)
                    .ConfigureAwait(false) is null)
            {
                await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                if (!context.Response.HasStarted)
                {
                    await RefuseAsync(context).ConfigureAwait(false);
                }
                return;
            }

            await transaction.CommitAsync(context.RequestAborted).ConfigureAwait(false);
        }
    }

    private static async Task RefuseAsync(HttpContext context)
    {
        var problem = ApiProblem.Create(
            context,
            StatusCodes.Status409Conflict,
            RefusalCode,
            "Worker execution refused",
            "The worker no longer owns a live execution for this job.");
        context.Response.StatusCode = StatusCodes.Status409Conflict;
        await context.Response.WriteAsJsonAsync(
            problem,
            options: null,
            contentType: "application/problem+json",
            cancellationToken: context.RequestAborted).ConfigureAwait(false);
    }
}
