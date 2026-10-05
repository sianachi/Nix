using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Templates;

/// <summary>Reads and manages the caller-visible template catalog.</summary>
public interface ITemplateCatalogStore
{
    public ValueTask<Result<TemplateLibrarySnapshot>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    public ValueTask<Result<TemplateDetailSnapshot>> DetailAsync(TemplateId templateId, CancellationToken cancellationToken);

    public ValueTask<Result<TemplateItemSnapshot>> ItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken);

    public ValueTask<Result<bool>> DeleteAsync(TemplateId templateId, CancellationToken cancellationToken);

    public ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        IReadOnlyDictionary<string, string>? inputs,
        int? expectedRevision,
        CancellationToken cancellationToken) =>
        PreflightAsync(templateId, mode, targetItemId, parentItemId, cancellationToken);

    public ValueTask<Result<TemplateExportSnapshot>> ExportAsync(
        TemplateId templateId,
        CancellationToken cancellationToken);

    public ValueTask<TemplateExportFileDownload?> AuthorizeExportFileAsync(
        TemplateId templateId,
        int expectedRevision,
        Guid fileVersionId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateExportFilesPage>> ExportFilesPageAsync(
        TemplateId templateId,
        int? expectedRevision,
        Guid? afterFileVersionId,
        int limit,
        CancellationToken cancellationToken);
}
