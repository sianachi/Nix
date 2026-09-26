using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Reads the capture source without returning any body content.</summary>
    public async ValueTask<Result<TemplateCaptureSnapshot>> PreviewCaptureAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        bool includeChildren,
        CancellationToken cancellationToken,
        bool excludeSampleDescendants = false)
    {
        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateCaptureSnapshot>(TemplateErrors.NotFound("No such workspace is visible."));
        }

        var source = await SourceTreeAsync(workspaceId, sourceItemId, includeChildren, cancellationToken)
            .ConfigureAwait(false);
        if (source.Count == 0 || source.Count > MaximumTemplateItems)
        {
            return Result.Failure<TemplateCaptureSnapshot>(TemplateErrors.NotFound("No such capture source is visible."));
        }

        var full = await CaptureSnapshotAsync(source, cancellationToken).ConfigureAwait(false);
        if (!excludeSampleDescendants || !includeChildren)
        {
            return Result.Success(full);
        }

        // SourceTreeAsync orders parents before children. Keep the root even if its title
        // begins with Sample:, matching the pet's descendant-only exclusion rule.
        var excluded = new HashSet<ItemId>();
        foreach (var item in source.Skip(1))
        {
            if (ItemProperties.ReadTitle(item.Properties).StartsWith("Sample: ", StringComparison.Ordinal)
                || (item.ParentId is { } parentId && excluded.Contains(parentId)))
            {
                excluded.Add(item.Id);
            }
        }
        if (excluded.Count == 0)
        {
            return Result.Success(full);
        }

        var projected = source.Where(item => !excluded.Contains(item.Id)).ToList();
        var capture = await CaptureSnapshotAsync(projected, cancellationToken).ConfigureAwait(false);
        return Result.Success(full with
        {
            ItemCount = projected.Count,
            CaptureFingerprint = capture.Fingerprint,
        });
    }

    private async ValueTask<TemplateCaptureSnapshot> CaptureSnapshotAsync(
        List<Item> source,
        CancellationToken cancellationToken)
    {
        var ids = source.Select(item => item.Id).ToArray();
        var heads = await _database.ContentDocs.AsNoTracking()
            .Where(doc => ids.Contains(doc.ItemId))
            .Select(doc => new { doc.ItemId, doc.Id, doc.HeadSeq })
            .ToDictionaryAsync(doc => doc.ItemId, cancellationToken)
            .ConfigureAwait(false);
        var files = await _database.FileBodies.AsNoTracking()
            .Where(body => ids.Contains(body.ItemId))
            .Select(body => new { body.ItemId, body.CurrentVersionId })
            .ToDictionaryAsync(body => body.ItemId, body => body.CurrentVersionId, cancellationToken)
            .ConfigureAwait(false);
        var bodyHeads = source.ToDictionary(item => item.Id,
            item => heads.TryGetValue(item.Id, out var head) ? (long?)head.HeadSeq : null);
        var bodyDocIds = source.ToDictionary(item => item.Id,
            item => heads.TryGetValue(item.Id, out var head) ? (Guid?)head.Id.Value : null);
        // The captured root stores its resolved schema, so an inherited schema change
        // outside the selected subtree must also invalidate approval.
        var rootSchema = await _schemas.ResolveForItemAsync(source[0].Id, cancellationToken)
            .ConfigureAwait(false);
        var values = source.OrderBy(item => item.Id.Value).Select(item => new
        {
            id = item.Id.Value,
            parentId = item.ParentId?.Value,
            item.Seq,
            item.Type,
            title = ItemProperties.ReadTitle(item.Properties),
            item.Properties,
            item.Schema,
            item.Views,
            item.Recurrence,
            item.LifecycleState,
            bodyHead = bodyHeads[item.Id],
            bodyDocId = bodyDocIds[item.Id],
            fileVersionId = files.TryGetValue(item.Id, out var version) ? (Guid?)version.Value : null,
        });
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            effectiveRootSchema = rootSchema,
            items = values,
        })));
        return new TemplateCaptureSnapshot(
            Convert.ToHexStringLower(digest),
            ItemProperties.ReadTitle(source[0].Properties),
            source.Count,
            bodyHeads,
            bodyDocIds,
            Convert.ToHexStringLower(digest));
    }
}
