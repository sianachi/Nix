using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Persistence;

namespace Nix.Features.Internal;

internal static class WorkerJobEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapPost("/worker/jobs", Create);
        group.MapPost("/worker/jobs/imports", CreateImport);
        group.MapPost("/worker/jobs/exports", CreateExport);
        group.MapGet("/worker/jobs/{jobId:guid}", Get);
        group.MapPost("/worker/jobs/{jobId:guid}/cancel", Cancel);
        group.MapPost("/worker/jobs/lease", Lease);
        group.MapPost("/worker/jobs/{jobId:guid}/complete", Complete);
    }

    private static async Task<Results<Ok<WorkerJobResponse>, ProblemHttpResult>> CreateImport(
        CreateImportWorkerJobRequest request,
        HttpContext httpContext,
        [FromServices] NixDbContext database,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (!configuration.GetValue("Nix:GoWorkers:ImportEnabled", false))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("The Go import worker is not enabled.")));
        }
        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        if (!await permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.NotFound("No such workspace is visible.")));
        }
        var format = NormalizeFormat(request.Format);
        if (!ImportFormats.Contains(format) || !ValidCapability(request.SourceUrl) || (!request.Preview && !ValidCapability(request.DestinationUrl)))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("The import format or capability URL is invalid.")));
        }
        var payload = JsonSerializer.Serialize(new
        {
            sourceUrl = request.SourceUrl,
            destinationUrl = request.DestinationUrl,
            expectedSha256 = request.ExpectedSha256,
            format,
            rootId = request.RootId,
            title = request.Title,
            preview = request.Preview,
        });
        return TypedResults.Ok(await CreateJob(database, session, "import." + format, request.IdempotencyKey, payload, workspaceId, cancellationToken).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<WorkerJobResponse>, ProblemHttpResult>> CreateExport(
        CreateExportWorkerJobRequest request,
        HttpContext httpContext,
        [FromServices] NixDbContext database,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (!configuration.GetValue("Nix:GoWorkers:ExportEnabled", false))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("The Go export worker is not enabled.")));
        }
        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        if (!await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.NotFound("No such workspace is visible.")));
        }
        var format = NormalizeFormat(request.Format);
        if (!ExportFormats.Contains(format) || !ValidCapability(request.SourceUrl) || !ValidCapability(request.DestinationUrl))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("The export format or capability URL is invalid.")));
        }
        var payload = JsonSerializer.Serialize(new
        {
            sourceUrl = request.SourceUrl,
            destinationUrl = request.DestinationUrl,
            expectedSha256 = request.ExpectedSha256,
            format,
        });
        return TypedResults.Ok(await CreateJob(database, session, "export." + format, request.IdempotencyKey, payload, workspaceId, cancellationToken).ConfigureAwait(false));
    }

    private static async Task<WorkerJobResponse> CreateJob(
        NixDbContext database,
        INixSessionContextAccessor session,
        string kind,
        string idempotencyKey,
        string payload,
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var existing = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(job => job.TenantId == context.TenantId && job.ActorId == context.PrincipalId && job.IdempotencyKey == idempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            return ToResponse(existing);
        }
        var now = DateTimeOffset.UtcNow;
        var job = new WorkerJob
        {
            Id = WorkerJobId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = workspaceId,
            ActorId = context.PrincipalId,
            Kind = kind,
            IdempotencyKey = idempotencyKey,
            Payload = payload,
            Status = "queued",
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.WorkerJobs.Add(job);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToResponse(job);
    }

    private static bool ValidCapability(Uri? uri)
    {
        if (uri is null || !uri.IsAbsoluteUri || uri.OriginalString.Length > 4096 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
        {
            return false;
        }
        return uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && (uri.IsLoopback || !uri.Host.Contains('.', StringComparison.Ordinal)));
    }

    private static string NormalizeFormat(string format)
    {
        if (format.Equals("md", StringComparison.OrdinalIgnoreCase) || format.Equals("markdown", StringComparison.OrdinalIgnoreCase))
        {
            return "markdown";
        }
        foreach (var candidate in new[] { "nix", "docx", "pdf" })
        {
            if (format.Equals(candidate, StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }
        }
        return string.Empty;
    }

    private static readonly HashSet<string> ImportFormats = ["nix", "markdown", "docx", "pdf"];
    private static readonly HashSet<string> ExportFormats = ["nix", "markdown", "docx", "pdf"];

    private static async Task<Results<Ok<WorkerJobResponse>, ProblemHttpResult>> Create(
        CreateWorkerJobRequest request,
        HttpContext httpContext,
        [FromServices] NixDbContext database,
        [FromServices] INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Kind) || string.IsNullOrWhiteSpace(request.IdempotencyKey))
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("Job kind and idempotency key are required.")));
        }
        try { using var _ = JsonDocument.Parse(request.Payload); }
        catch (JsonException)
        {
            return TypedResults.Problem(InternalEndpoints.Problem(httpContext, InternalErrors.InvalidRequest("Job payload must be valid JSON.")));
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var existing = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(job => job.TenantId == context.TenantId && job.ActorId == context.PrincipalId && job.IdempotencyKey == request.IdempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            return TypedResults.Ok(ToResponse(existing));
        }

        var now = DateTimeOffset.UtcNow;
        var job = new WorkerJob
        {
            Id = WorkerJobId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = request.WorkspaceId is null
                ? null
                : Nix.Domain.Tenancy.WorkspaceId.From(request.WorkspaceId.Value),
            ActorId = context.PrincipalId,
            Kind = request.Kind,
            IdempotencyKey = request.IdempotencyKey,
            Payload = request.Payload,
            Status = "queued",
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.WorkerJobs.Add(job);
        if (request.Outbox is not null)
        {
            database.WorkerOutboxEvents.Add(new WorkerOutboxEvent
            {
                Id = WorkerOutboxEventId.Create(),
                TenantId = context.TenantId,
                WorkspaceId = job.WorkspaceId,
                Kind = request.Outbox.Kind,
                AggregateVersion = request.Outbox.AggregateVersion,
                Payload = request.Outbox.Payload,
                AvailableAt = now,
            });
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok(ToResponse(job));
    }

    private static async Task<Results<Ok<WorkerJobResponse>, NotFound>> Get(Guid jobId, HttpContext httpContext, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await database.WorkerJobs.AsNoTracking().SingleOrDefaultAsync(item => item.TenantId == tenant && item.Id == WorkerJobId.From(jobId), cancellationToken).ConfigureAwait(false);
        return job is null ? TypedResults.NotFound() : TypedResults.Ok(ToResponse(job));
    }

    private static async Task<Results<NoContent, NotFound>> Cancel(Guid jobId, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var changed = await database.WorkerJobs.Where(job => job.TenantId == tenant && job.Id == WorkerJobId.From(jobId)).ExecuteUpdateAsync(setters => setters.SetProperty(job => job.CancellationRequested, true).SetProperty(job => job.UpdatedAt, DateTimeOffset.UtcNow), cancellationToken).ConfigureAwait(false);
        return changed == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    private static async Task<Ok<IReadOnlyList<WorkerJobResponse>>> Lease(LeaseWorkerJobsRequest request, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.AddSeconds(Math.Clamp(request.LeaseSeconds, 5, 300));
        var query = database.WorkerJobs.Where(job => job.TenantId == tenant && (job.Status == "queued" || (job.Status == "running" && job.LeaseUntil < now)) && !job.CancellationRequested);
        if (!string.IsNullOrWhiteSpace(request.Kind))
        {
            query = query.Where(job => job.Kind == request.Kind);
        }
        var jobs = await query.OrderBy(job => job.CreatedAt).Take(Math.Clamp(request.Limit, 1, 100)).ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var job in jobs) { job.Status = "running"; job.Attempts++; job.LeaseOwner = request.Owner; job.LeaseUntil = leaseUntil; job.StartedAt ??= now; job.UpdatedAt = now; }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok<IReadOnlyList<WorkerJobResponse>>(jobs.Select(ToResponse).ToArray());
    }

    private static async Task<Results<NoContent, NotFound>> Complete(Guid jobId, CompleteWorkerJobRequest request, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await database.WorkerJobs.SingleOrDefaultAsync(item => item.TenantId == tenant && item.Id == WorkerJobId.From(jobId), cancellationToken).ConfigureAwait(false);
        if (job is null)
        {
            return TypedResults.NotFound();
        }
        job.Status = request.Succeeded ? "completed" : "failed"; job.Result = request.Result; job.ErrorCode = request.ErrorCode; job.ErrorDetail = request.ErrorDetail; job.LeaseOwner = null; job.LeaseUntil = null; job.CompletedAt = DateTimeOffset.UtcNow; job.UpdatedAt = DateTimeOffset.UtcNow;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static WorkerJobResponse ToResponse(WorkerJob job) => new(job.Id.Value, job.Kind, job.Status, job.Payload, job.Result, job.ErrorCode, job.ErrorDetail, job.Attempts, job.CancellationRequested, job.CreatedAt, job.CompletedAt);
}

public sealed record CreateWorkerJobRequest(string Kind, string IdempotencyKey, string Payload, Guid? WorkspaceId = null, WorkerOutboxRequest? Outbox = null);
public sealed record CreateImportWorkerJobRequest(Guid WorkspaceId, string Format, Uri SourceUrl, Uri? DestinationUrl, string RootId, string Title, string IdempotencyKey, string? ExpectedSha256 = null, bool Preview = false);
public sealed record CreateExportWorkerJobRequest(Guid WorkspaceId, string Format, Uri SourceUrl, Uri DestinationUrl, string IdempotencyKey, string? ExpectedSha256 = null);
public sealed record WorkerOutboxRequest(string Kind, string Payload, long? AggregateVersion = null);
public sealed record LeaseWorkerJobsRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record CompleteWorkerJobRequest(bool Succeeded, string? Result = null, string? ErrorCode = null, string? ErrorDetail = null);
public sealed record WorkerJobResponse(Guid Id, string Kind, string Status, string Payload, string? Result, string? ErrorCode, string? ErrorDetail, int Attempts, bool CancellationRequested, DateTimeOffset CreatedAt, DateTimeOffset? CompletedAt);
