using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Updates editable template metadata.</summary>
public readonly record struct UpdateTemplateDraft(
    TemplateId TemplateId,
    TemplateOperationId OperationId,
    string? Title,
    string? Description) : ICommand<TemplateDraftPlan>;

/// <summary>Updates editable template metadata.</summary>
public sealed class UpdateTemplateDraftHandler(ITemplateDraftStore drafts)
    : ICommandHandler<UpdateTemplateDraft, TemplateDraftPlan>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateDraftPlan>> HandleAsync(
        UpdateTemplateDraft command,
        CancellationToken cancellationToken) =>
        drafts.UpdateDraftMetadataAsync(
            command.TemplateId,
            command.OperationId,
            command.Title,
            command.Description,
            cancellationToken);
}
