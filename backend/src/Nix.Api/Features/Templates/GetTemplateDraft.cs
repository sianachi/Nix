using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Reads an editable template revision.</summary>
public readonly record struct GetTemplateDraft(TemplateId TemplateId, TemplateOperationId OperationId)
    : IQuery<Result<TemplateDraftPlan>>;

/// <summary>Reads an editable template revision.</summary>
public sealed class GetTemplateDraftHandler(ITemplateDraftStore drafts)
    : IQueryHandler<GetTemplateDraft, Result<TemplateDraftPlan>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateDraftPlan>> HandleAsync(
        GetTemplateDraft query,
        CancellationToken cancellationToken) =>
        drafts.DraftAsync(query.TemplateId, query.OperationId, cancellationToken);
}
