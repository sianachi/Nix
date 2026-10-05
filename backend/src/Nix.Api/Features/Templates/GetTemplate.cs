using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Reads one active template.</summary>
public readonly record struct GetTemplate(TemplateId TemplateId) : IQuery<Result<TemplateDetailSnapshot>>;

/// <summary>Reads one active template.</summary>
public sealed class GetTemplateHandler(ITemplateCatalogStore templates)
    : IQueryHandler<GetTemplate, Result<TemplateDetailSnapshot>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateDetailSnapshot>> HandleAsync(
        GetTemplate query,
        CancellationToken cancellationToken) =>
        templates.DetailAsync(query.TemplateId, cancellationToken);
}
