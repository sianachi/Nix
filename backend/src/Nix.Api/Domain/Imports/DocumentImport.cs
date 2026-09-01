using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Domain.Importing;

/// <summary>Durable preview and atomic-publication state for one uploaded document.</summary>
public sealed class DocumentImport
{
    public required DocumentImportId Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required PrincipalId ActorId { get; init; }
    public required FileUploadId UploadId { get; init; }
    public ItemId? ParentId { get; init; }
    public required string Format { get; init; }
    public required string Title { get; init; }
    public required string IdempotencyKey { get; init; }
    public required string Status { get; set; }
    public WorkerJobId? PreviewJobId { get; set; }
    public WorkerJobId? CommitJobId { get; set; }
    public required string PlanObjectKey { get; init; }
    public string? PlanSha256 { get; set; }
    public long? PlanByteLength { get; set; }
    public string? SourceSha256 { get; set; }
    public int? ItemCount { get; set; }
    public int? AssetCount { get; set; }
    public string? Loss { get; set; }
    public string? Omissions { get; set; }
    public ItemId? RootItemId { get; set; }
    public string? FailureCode { get; set; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}

public static class DocumentImportStatuses
{
    public const string PendingUpload = "pending_upload";
    public const string PreviewQueued = "preview_queued";
    public const string PreviewReady = "preview_ready";
    public const string CommitQueued = "commit_queued";
    public const string Staging = "staging";
    public const string Completed = "completed";
    public const string Cancelled = "cancelled";
    public const string Failed = "failed";
}
