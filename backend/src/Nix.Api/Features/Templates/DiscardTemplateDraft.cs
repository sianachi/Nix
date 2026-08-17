using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Discards an editable template revision.</summary>
public readonly record struct DiscardTemplateDraft(TemplateId TemplateId, TemplateOperationId OperationId)
    : ICommand<bool>;

/// <summary>Discards an editable template revision after verifying its template identity.</summary>
public sealed class DiscardTemplateDraftHandler(
    ITemplateDraftStore drafts,
    ITemplateStagingStore stages) : ICommandHandler<DiscardTemplateDraft, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(
        DiscardTemplateDraft command,
        CancellationToken cancellationToken)
    {
        var draft = await drafts.DraftAsync(
            command.TemplateId,
            command.OperationId,
            cancellationToken).ConfigureAwait(false);
        return draft.IsFailure
            ? Result.Failure<bool>(draft.Error)
            : await stages.AbortOperationAsync(command.OperationId, cancellationToken).ConfigureAwait(false);
    }
}
