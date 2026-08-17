using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Updates one item in an editable template revision.</summary>
public readonly record struct UpdateTemplateDraftItem(
    TemplateId TemplateId,
    TemplateOperationId OperationId,
    Guid SourceId,
    string? Title,
    string? Properties,
    string? Schema,
    string? Views) : ICommand<TemplateItemSnapshot>;

/// <summary>Updates one item in an editable template revision.</summary>
public sealed class UpdateTemplateDraftItemHandler(ITemplateDraftStore drafts)
    : ICommandHandler<UpdateTemplateDraftItem, TemplateItemSnapshot>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateItemSnapshot>> HandleAsync(
        UpdateTemplateDraftItem command,
        CancellationToken cancellationToken) =>
        drafts.UpdateDraftItemAsync(
            command.TemplateId,
            command.OperationId,
            command.SourceId,
            command.Title,
            command.Properties,
            command.Schema,
            command.Views,
            cancellationToken);
}
