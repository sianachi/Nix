using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Importing;

/// <summary>One immutable archive file version staged for a hidden document-import item.</summary>
public sealed class DocumentImportFileVersion
{
    public required Guid TransferId { get; init; }
    public required TenantId TenantId { get; init; }
    public required DocumentImportId ImportId { get; init; }
    public required string SourceItemId { get; init; }
    public required ItemId TargetItemId { get; init; }
    public required FileVersionId FileVersionId { get; init; }
    public required string ObjectKey { get; init; }
    public required string FileName { get; init; }
    public required string MediaType { get; init; }
    public required long ByteLength { get; init; }
    public required string Sha256 { get; init; }
    public required bool Previewable { get; init; }
    public int? PixelWidth { get; init; }
    public int? PixelHeight { get; init; }
    public required bool ObjectReady { get; set; }
    public string? ExecutionId { get; set; }
}
