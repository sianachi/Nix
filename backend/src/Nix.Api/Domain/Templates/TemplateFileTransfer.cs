using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>One immutable file-version copy owned by a staged template operation.</summary>
public sealed class TemplateFileTransfer
{
    public required Guid Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public TemplateOperationId? OperationId { get; init; }
    public TemplateApplicationId? ApplicationId { get; init; }
    public required ItemId SourceItemId { get; init; }
    public required ItemId TargetItemId { get; init; }
    public required FileVersionId TargetVersionId { get; init; }
    public required string SourceObjectKey { get; init; }
    public required string FileName { get; init; }
    public required string MediaType { get; init; }
    public required long ByteLength { get; init; }
    public required string Sha256 { get; init; }
    public required bool Previewable { get; init; }
    public int? PixelWidth { get; init; }
    public int? PixelHeight { get; init; }
    public string? ExecutionId { get; set; }
}

/// <summary>Database-authorized metadata used to sign a single worker's direct-copy URLs.</summary>
public sealed record TemplateFileTransferAuthorization(
    Guid TransferId,
    Guid SourceItemId,
    Guid TargetItemId,
    int TargetVersion,
    string SourceObjectKey,
    string TargetObjectKey,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool TargetReady);

/// <summary>One bounded, deterministic page of capabilities for a template file-copy job.</summary>
public sealed record TemplateFileTransferPage(
    IReadOnlyList<TemplateFileTransferAuthorization> Transfers,
    Guid? NextAfterTransferId,
    bool Complete);
