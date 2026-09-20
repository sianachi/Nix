using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Reads the portable snapshot for one active template.</summary>
public readonly record struct ExportTemplate(TemplateId TemplateId) : IQuery<Result<TemplateExportSnapshot>>;

/// <summary>Reads the portable snapshot for one active template.</summary>
public sealed class ExportTemplateHandler(ITemplateCatalogStore templates)
    : IQueryHandler<ExportTemplate, Result<TemplateExportSnapshot>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateExportSnapshot>> HandleAsync(
        ExportTemplate query,
        CancellationToken cancellationToken) =>
        templates.ExportAsync(query.TemplateId, cancellationToken);
}

/// <summary>Authorizes a just-in-time capability for one immutable template file version.</summary>
public readonly record struct AuthorizeTemplateExportFile(
    TemplateId TemplateId, int ExpectedRevision, Guid FileVersionId) : IQuery<TemplateExportFileDownload?>;

/// <summary>Authorizes a just-in-time capability for one immutable template file version.</summary>
public sealed class AuthorizeTemplateExportFileHandler(ITemplateCatalogStore templates)
    : IQueryHandler<AuthorizeTemplateExportFile, TemplateExportFileDownload?>
{
    public ValueTask<TemplateExportFileDownload?> HandleAsync(
        AuthorizeTemplateExportFile query, CancellationToken cancellationToken) =>
        templates.AuthorizeExportFileAsync(query.TemplateId, query.ExpectedRevision, query.FileVersionId, cancellationToken);
}

/// <summary>Reads a bounded page of file history metadata under a pinned template revision.</summary>
public readonly record struct ExportTemplateFiles(
    TemplateId TemplateId, int? ExpectedRevision, Guid? AfterFileVersionId, int Limit)
    : IQuery<Result<TemplateExportFilesPage>>;

/// <summary>Reads a bounded page of file history metadata under a pinned template revision.</summary>
public sealed class ExportTemplateFilesHandler(ITemplateCatalogStore templates)
    : IQueryHandler<ExportTemplateFiles, Result<TemplateExportFilesPage>>
{
    public ValueTask<Result<TemplateExportFilesPage>> HandleAsync(
        ExportTemplateFiles query, CancellationToken cancellationToken) =>
        templates.ExportFilesPageAsync(query.TemplateId, query.ExpectedRevision,
            query.AfterFileVersionId, query.Limit, cancellationToken);
}
