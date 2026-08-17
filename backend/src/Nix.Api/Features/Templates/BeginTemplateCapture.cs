using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Begins capture of an item subtree as a template.</summary>
public readonly record struct BeginTemplateCapture(
    WorkspaceId WorkspaceId,
    ItemId SourceItemId,
    string Title,
    string? Description,
    bool IncludeBody,
    bool IncludeChildren,
    string IdempotencyKey) : ICommand<TemplateCapturePlan>;

/// <summary>Begins capture of an item subtree as a template.</summary>
public sealed class BeginTemplateCaptureHandler(ITemplateStagingStore stages)
    : ICommandHandler<BeginTemplateCapture, TemplateCapturePlan>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateCapturePlan>> HandleAsync(
        BeginTemplateCapture command,
        CancellationToken cancellationToken) =>
        stages.BeginCaptureAsync(
            command.WorkspaceId,
            command.SourceItemId,
            command.Title,
            command.Description,
            command.IncludeBody,
            command.IncludeChildren,
            command.IdempotencyKey,
            cancellationToken);
}
