using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Files;

/// <summary>One immutable version of a file body.</summary>
public sealed class FileVersion
{
    public required FileVersionId Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required ItemId ItemId { get; init; }
    public required int Version { get; init; }
    public required string ObjectKey { get; init; }
    public required string FileName { get; init; }
    public required string MediaType { get; init; }
    public required long ByteLength { get; init; }
    public required string Sha256 { get; init; }
    public int? PixelWidth { get; init; }
    public int? PixelHeight { get; init; }
    public required bool Previewable { get; init; }
    public required PrincipalId CreatedBy { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}
