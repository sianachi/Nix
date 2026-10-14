using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Sites;
using Nix.Messaging;

namespace Nix.Features.Admin;

/// <summary>Reads the recent nightly backup results (instance-wide, operators only).</summary>
/// <param name="Limit">1 to 100.</param>
public sealed record ListBackupRuns(int Limit) : IQuery<Result<BackupRunListResponse>>;

/// <summary>One recorded backup step.</summary>
/// <param name="Id">The row.</param>
/// <param name="StartedAt">When the step began.</param>
/// <param name="FinishedAt">When it ended.</param>
/// <param name="Step"><c>local</c> or <c>offsite</c>.</param>
/// <param name="Status"><c>succeeded</c> or <c>failed</c>.</param>
/// <param name="SnapshotId">The restic snapshot of an off-host push.</param>
/// <param name="Bytes">The size of the local backup directory.</param>
/// <param name="Error">A fixed phrase and exit code written by the scripts; render as plain text.</param>
public sealed record BackupRunResponse(
    Guid Id,
    DateTimeOffset StartedAt,
    DateTimeOffset FinishedAt,
    string Step,
    string Status,
    string? SnapshotId,
    long? Bytes,
    string? Error);

/// <summary>The newest backup steps first.</summary>
/// <param name="Runs">The steps.</param>
public sealed record BackupRunListResponse(IReadOnlyList<BackupRunResponse> Runs);

/// <summary>
/// Lists backup runs for the principals named in <c>Nix:Sites:Operators</c> only. The data is
/// instance-wide, so the tenant-administrator fallback the site approvals use does not apply and
/// an empty list means nobody.
/// </summary>
public sealed class ListBackupRunsHandler(SiteOperators operators, IBackupRunStore runs)
    : IQueryHandler<ListBackupRuns, Result<BackupRunListResponse>>
{
    /// <summary>Stable code for a caller who is not an instance operator.</summary>
    public const string OperatorRequiredCode = "admin.operator_required";

    /// <inheritdoc />
    public async ValueTask<Result<BackupRunListResponse>> HandleAsync(ListBackupRuns query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!await operators.IsInstanceOperatorAsync().ConfigureAwait(false))
        {
            return Result.Failure<BackupRunListResponse>(new(OperatorRequiredCode, "Only an operator of this deployment may read backup status."));
        }

        var found = await runs.ListAsync(query.Limit, cancellationToken).ConfigureAwait(false);
        return Result.Success(new BackupRunListResponse([.. found.Select(run => new BackupRunResponse(
            run.Id, run.StartedAt, run.FinishedAt, run.Step, run.Status, run.SnapshotId, run.Bytes, run.Error))]));
    }
}

internal static class BackupEndpoints
{
    private const string InvalidLimitCode = "admin.invalid_limit";

    internal static IEndpointRouteBuilder MapBackupEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        endpoints.MapGet("/api/v1/admin/backups", List)
            .WithTags("Admin")
            .WithName("ListBackupRuns")
            .WithSummary("Recent nightly backup results")
            .WithDescription("Newest first. Instance-wide, so only the principals in Nix:Sites:Operators may read it; an empty list means nobody.")
            .Produces<BackupRunListResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status403Forbidden);
        return endpoints;
    }

    private static async Task<IResult> List(HttpContext context, [FromServices] NixDispatcher dispatcher, int limit = 20)
    {
        if (limit is < 1 or > 100)
        {
            return TypedResults.Problem(ApiProblem.Create(
                context, StatusCodes.Status400BadRequest, InvalidLimitCode, "Request refused", "limit must be between 1 and 100."));
        }

        var result = await dispatcher
            .QueryAsync<ListBackupRuns, Result<BackupRunListResponse>>(new ListBackupRuns(limit), context.RequestAborted)
            .ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.Ok(result.Value)
            : TypedResults.Problem(ApiProblem.Create(
                context, StatusCodes.Status403Forbidden, result.Error.Code, "Request refused", result.Error.Message));
    }
}

/// <summary>The admin feature's JSON contract, source-generated.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BackupRunListResponse))]
internal sealed partial class AdminJsonContext : JsonSerializerContext;
