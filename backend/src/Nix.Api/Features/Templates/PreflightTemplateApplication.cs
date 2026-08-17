using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Plans a template application without mutating its target.</summary>
public readonly record struct PreflightTemplateApplication(
    TemplateId TemplateId,
    TemplateApplicationMode Mode,
    ItemId? TargetItemId,
    ItemId? ParentItemId) : IQuery<Result<TemplatePreflight>>;

/// <summary>Plans a template application without mutating its target.</summary>
public sealed class PreflightTemplateApplicationHandler(ITemplateCatalogStore templates)
    : IQueryHandler<PreflightTemplateApplication, Result<TemplatePreflight>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplatePreflight>> HandleAsync(
        PreflightTemplateApplication query,
        CancellationToken cancellationToken) =>
        templates.PreflightAsync(
            query.TemplateId,
            query.Mode,
            query.TargetItemId,
            query.ParentItemId,
            cancellationToken);
}
