using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Reads one item from an active template tree.</summary>
public readonly record struct GetTemplateItem(TemplateId TemplateId, Guid SourceId)
    : IQuery<Result<TemplateItemSnapshot>>;

/// <summary>Reads one item from an active template tree.</summary>
public sealed class GetTemplateItemHandler(ITemplateCatalogStore templates)
    : IQueryHandler<GetTemplateItem, Result<TemplateItemSnapshot>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateItemSnapshot>> HandleAsync(
        GetTemplateItem query,
        CancellationToken cancellationToken) =>
        templates.ItemAsync(query.TemplateId, query.SourceId, cancellationToken);
}
