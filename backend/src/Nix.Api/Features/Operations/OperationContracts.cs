using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Abstractions.Workers;

namespace Nix.Features.Operations;

public sealed record OperationResponse(
    Guid Id,
    string Kind,
    string Status,
    JsonElement? Result,
    string? ErrorCode,
    string? ErrorDetail,
    int Attempts,
    bool CancellationRequested,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

internal static class OperationMapping
{
    internal static OperationResponse ToResponse(WorkerJobRecord job)
    {
        JsonElement? result = null;
        if (!string.IsNullOrWhiteSpace(job.Result))
        {
            using var document = JsonDocument.Parse(
                job.Result,
                new JsonDocumentOptions { MaxDepth = 32, AllowTrailingCommas = false });
            result = document.RootElement.Clone();
        }
        return new OperationResponse(
            job.Id,
            job.Kind,
            job.Status,
            result,
            job.ErrorCode,
            job.ErrorDetail,
            job.Attempts,
            job.CancellationRequested,
            job.CreatedAt,
            job.CompletedAt);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(OperationResponse))]
internal sealed partial class OperationsJsonContext : JsonSerializerContext;
