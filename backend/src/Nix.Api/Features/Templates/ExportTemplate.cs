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
