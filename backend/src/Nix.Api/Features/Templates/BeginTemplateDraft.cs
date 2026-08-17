using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Begins an editable template revision.</summary>
public readonly record struct BeginTemplateDraft(TemplateId TemplateId, string IdempotencyKey)
    : ICommand<TemplateDraftPlan>;

/// <summary>Begins an editable template revision.</summary>
public sealed class BeginTemplateDraftHandler(ITemplateDraftStore drafts)
    : ICommandHandler<BeginTemplateDraft, TemplateDraftPlan>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateDraftPlan>> HandleAsync(
        BeginTemplateDraft command,
        CancellationToken cancellationToken) =>
        drafts.BeginDraftAsync(command.TemplateId, command.IdempotencyKey, cancellationToken);
}
