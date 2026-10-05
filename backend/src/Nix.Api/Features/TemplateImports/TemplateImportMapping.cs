using System.Text.Json;
using Nix.Abstractions.Importing;
using Nix.Domain.Importing;
using Nix.Domain.Templates;

namespace Nix.Features.TemplateImports;

/// <summary>Maps durable template import records onto their response shapes.</summary>
internal static class TemplateImportMapping
{
    internal static TemplateImportResponse ToResponse(DocumentImportRecord value) => new(
        value.Id,
        value.WorkspaceId,
        value.Status,
        value.PreviewJobId,
        value.CommitJobId,
        ParsePreview(value.TemplatePreview),
        value.TemplateId is null
            || value.TemplateStableKey is null
            || value.TemplateDigest is null
            || value.TemplateUnchanged is null
                ? null
                : new TemplateImportResultResponse(
                    value.TemplateOperationId,
                    value.TemplateId.Value,
                    value.TemplateStableKey,
                    value.TemplateDigest,
                    value.TemplateUnchanged.Value,
                    ParseIds(value.TemplateWrittenTargetItemIds)),
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    internal static WorkerCompleteTemplateImportResponse? WorkerResult(DocumentImportRecord value)
    {
        var preview = ParsePreview(value.TemplatePreview);
        return preview is null
            || value.TemplateId is null
            || value.TemplateStableKey is null
            || value.TemplateDigest is null
            || value.TemplateUnchanged is null
                ? null
                : new WorkerCompleteTemplateImportResponse(
                    value.Id,
                    value.TemplateOperationId,
                    value.TemplateId.Value,
                    value.TemplateStableKey,
                    value.TemplateDigest,
                    value.TemplateUnchanged.Value,
                    preview.ItemCount,
                    preview.BodyCount,
                    ParseIds(value.TemplateWrittenTargetItemIds));
    }

    internal static TemplateImportPreviewResponse? ParsePreview(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }
        return JsonSerializer.Deserialize(
            json,
            TemplateImportsJsonContext.Default.TemplateImportPreviewResponse)
            ?? throw new InvalidOperationException("A durable template preview cannot be null.");
    }

    internal static Guid[] ParseIds(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 2 });
        return document.RootElement.EnumerateArray().Select(value => value.GetGuid()).ToArray();
    }

    internal static bool StoredIdsEqual(string? stored, IReadOnlyList<Guid> requested) =>
        ParseIds(stored).Order().SequenceEqual(requested.Distinct().Order());

    internal static TemplateImportItemMappingResponse Map(TemplateItemMapping value) =>
        new(value.SourceId, value.ItemId.Value, value.ItemType);

    internal static TemplateImportItemMappingResponse Map(TemplateBodyWrite value) =>
        new(value.SourceId, value.TargetItemId.Value, value.ItemType);

    internal static string Origin(string purpose) => purpose switch
    {
        DocumentImportPurposes.TemplateUser => "user",
        DocumentImportPurposes.TemplateManaged => "managed",
        _ => throw new InvalidOperationException("A non-template purpose reached the template import boundary."),
    };
}
