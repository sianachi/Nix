using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Atomically publishes an editable template revision.</summary>
public readonly record struct SaveTemplateDraft(TemplateId TemplateId, TemplateOperationId OperationId)
    : ICommand<TemplateId>;

/// <summary>Atomically publishes an editable template revision.</summary>
public sealed class SaveTemplateDraftHandler(ITemplateDraftStore drafts)
    : ICommandHandler<SaveTemplateDraft, TemplateId>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateId>> HandleAsync(
        SaveTemplateDraft command,
        CancellationToken cancellationToken) =>
        drafts.SaveDraftAsync(command.TemplateId, command.OperationId, cancellationToken);
}
