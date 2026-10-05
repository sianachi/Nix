using Nix.Domain.Items;

namespace Nix.Abstractions.Templates;

/// <summary>An approved, body-content-free description of a capture source.</summary>
public sealed record TemplateCaptureSnapshot(
    string Fingerprint,
    string SourceTitle,
    int ItemCount,
    IReadOnlyDictionary<ItemId, long?> BodyHeads,
    IReadOnlyDictionary<ItemId, Guid?> BodyDocIds,
    string CaptureFingerprint);
