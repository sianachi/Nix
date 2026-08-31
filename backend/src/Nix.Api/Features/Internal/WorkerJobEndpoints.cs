using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Tenancy;

namespace Nix.Features.Internal;

internal static class WorkerJobEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
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
        [FromServices] IWorkerJobStore jobs,
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
        if (!ImportFormats.Contains(format) ||
            !ValidCapability(request.SourceUrl) ||
            (!request.Preview && !ValidCapability(request.DestinationUrl)) ||
            !ValidText(request.RootId, 200) ||
            !ValidText(request.Title, 500) ||
            !ValidText(request.IdempotencyKey, 200))
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
        return TypedResults.Ok(await CreateJob(jobs, session, "import." + format, request.IdempotencyKey, payload, workspaceId, cancellationToken).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<WorkerJobResponse>, ProblemHttpResult>> CreateExport(
        CreateExportWorkerJobRequest request,
        HttpContext httpContext,
        [FromServices] IWorkerJobStore jobs,
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
        if (!ExportFormats.Contains(format) ||
            !ValidCapability(request.SourceUrl) ||
            !ValidCapability(request.DestinationUrl) ||
            !ValidText(request.IdempotencyKey, 200))
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
        return TypedResults.Ok(await CreateJob(jobs, session, "export." + format, request.IdempotencyKey, payload, workspaceId, cancellationToken).ConfigureAwait(false));
    }

    private static async Task<WorkerJobResponse> CreateJob(
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        string kind,
        string idempotencyKey,
        string payload,
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return ToResponse(await jobs.CreateAsync(context.TenantId, context.PrincipalId, workspaceId, kind, idempotencyKey, payload, cancellationToken).ConfigureAwait(false));
    }

    private static bool ValidCapability(Uri? uri)
    {
        if (uri is null || !uri.IsAbsoluteUri || uri.OriginalString.Length > 4096 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
        {
            return false;
        }
        return uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && (uri.IsLoopback || !uri.Host.Contains('.', StringComparison.Ordinal)));
    }

    private static bool ValidText(string value, int maxLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maxLength;

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

    private static async Task<Results<Ok<WorkerJobResponse>, NotFound>> Get(Guid jobId, [FromServices] IWorkerJobStore jobs, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(context.TenantId, context.PrincipalId, jobId, cancellationToken).ConfigureAwait(false);
        return job is null ? TypedResults.NotFound() : TypedResults.Ok(ToResponse(job));
    }

    private static async Task<Results<NoContent, NotFound>> Cancel(Guid jobId, [FromServices] IWorkerJobStore jobs, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return await jobs.CancelAsync(context.TenantId, context.PrincipalId, jobId, cancellationToken).ConfigureAwait(false) ? TypedResults.NoContent() : TypedResults.NotFound();
    }

    private static async Task<Ok<IReadOnlyList<WorkerJobResponse>>> Lease(LeaseWorkerJobsRequest request, [FromServices] IWorkerJobStore jobs, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var leased = await jobs.LeaseAsync(tenant, request.Owner, request.Kind, Math.Clamp(request.Limit, 1, 100), Math.Clamp(request.LeaseSeconds, 5, 300), cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok<IReadOnlyList<WorkerJobResponse>>(leased.Select(ToResponse).ToArray());
    }

    private static async Task<Results<NoContent, NotFound>> Complete(Guid jobId, CompleteWorkerJobRequest request, [FromServices] IWorkerJobStore jobs, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return await jobs.CompleteAsync(tenant, jobId, request.Succeeded, request.Result, request.ErrorCode, request.ErrorDetail, cancellationToken).ConfigureAwait(false) ? TypedResults.NoContent() : TypedResults.NotFound();
    }

    private static WorkerJobResponse ToResponse(WorkerJobRecord job) => new(job.Id, job.Kind, job.Status, job.Payload, job.Result, job.ErrorCode, job.ErrorDetail, job.Attempts, job.CancellationRequested, job.CreatedAt, job.CompletedAt);
}

public sealed record CreateImportWorkerJobRequest(Guid WorkspaceId, string Format, Uri SourceUrl, Uri? DestinationUrl, string RootId, string Title, string IdempotencyKey, string? ExpectedSha256 = null, bool Preview = false);
public sealed record CreateExportWorkerJobRequest(Guid WorkspaceId, string Format, Uri SourceUrl, Uri DestinationUrl, string IdempotencyKey, string? ExpectedSha256 = null);
public sealed record LeaseWorkerJobsRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record CompleteWorkerJobRequest(bool Succeeded, string? Result = null, string? ErrorCode = null, string? ErrorDetail = null);
public sealed record WorkerJobResponse(Guid Id, string Kind, string Status, string Payload, string? Result, string? ErrorCode, string? ErrorDetail, int Attempts, bool CancellationRequested, DateTimeOffset CreatedAt, DateTimeOffset? CompletedAt);
