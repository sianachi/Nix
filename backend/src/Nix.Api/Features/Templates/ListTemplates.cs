using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Lists templates visible in one workspace.</summary>
public readonly record struct ListTemplates(WorkspaceId WorkspaceId) : IQuery<Result<TemplateLibrarySnapshot>>;

/// <summary>Lists templates visible in one workspace.</summary>
public sealed class ListTemplatesHandler(ITemplateCatalogStore templates)
    : IQueryHandler<ListTemplates, Result<TemplateLibrarySnapshot>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateLibrarySnapshot>> HandleAsync(
        ListTemplates query,
        CancellationToken cancellationToken) =>
        templates.ListAsync(query.WorkspaceId, cancellationToken);
}
