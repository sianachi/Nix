using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Describes the exact current source without returning its body content.</summary>
public readonly record struct PreviewTemplateCapture(
    WorkspaceId WorkspaceId,
    ItemId SourceItemId,
    bool IncludeChildren) : IQuery<Result<TemplateCaptureSnapshot>>;

/// <summary>Describes the exact current source without returning its body content.</summary>
public sealed class PreviewTemplateCaptureHandler(ITemplateStagingStore stages)
    : IQueryHandler<PreviewTemplateCapture, Result<TemplateCaptureSnapshot>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateCaptureSnapshot>> HandleAsync(
        PreviewTemplateCapture query,
        CancellationToken cancellationToken) =>
        stages.PreviewCaptureAsync(
            query.WorkspaceId,
            query.SourceItemId,
            query.IncludeChildren,
            cancellationToken);
}
