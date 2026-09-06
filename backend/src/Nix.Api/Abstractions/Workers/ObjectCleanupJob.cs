using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Workers;

public sealed record ObjectCleanupJobPayload(
    string OwnerKind,
    Guid OwnerId,
    DateTimeOffset NotBefore,
    IReadOnlyList<string> ObjectKeys);

public static class ObjectCleanupJobs
{
    public const string Kind = "object.cleanup";

    public static ValueTask<WorkerJobRecord> QueueAsync(
        IWorkerJobStore jobs,
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId workspaceId,
        string ownerKind,
        Guid ownerId,
        DateTimeOffset notBefore,
        IEnumerable<string> objectKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(jobs);
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerKind);
        ArgumentNullException.ThrowIfNull(objectKeys);
        var keys = objectKeys.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        if (keys.Length > 10_002 || keys.Any(key => string.IsNullOrWhiteSpace(key) || key.Length > 1024))
        {
            throw new ArgumentException("Object cleanup targets are invalid.", nameof(objectKeys));
        }
        var payload = JsonSerializer.Serialize(
            new ObjectCleanupJobPayload(ownerKind, ownerId, notBefore, keys),
            ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
        return jobs.CreateAsync(
            tenantId,
            actorId,
            workspaceId,
            Kind,
            $"object.cleanup:{ownerKind}:{ownerId:D}",
            payload,
            cancellationToken);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ObjectCleanupJobPayload))]
public sealed partial class ObjectCleanupJsonContext : JsonSerializerContext;
