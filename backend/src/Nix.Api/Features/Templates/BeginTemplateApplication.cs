using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Begins an atomic create or merge application.</summary>
public readonly record struct BeginTemplateApplication(
    TemplateId TemplateId,
    TemplateApplicationMode Mode,
    ItemId? TargetItemId,
    ItemId? ParentItemId,
    string? Title,
    string IdempotencyKey) : ICommand<TemplateApplicationPlan>;

/// <summary>Begins an atomic create or merge application.</summary>
public sealed class BeginTemplateApplicationHandler(ITemplateApplicationStore applications)
    : ICommandHandler<BeginTemplateApplication, TemplateApplicationPlan>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateApplicationPlan>> HandleAsync(
        BeginTemplateApplication command,
        CancellationToken cancellationToken) =>
        applications.BeginApplicationAsync(
            command.TemplateId,
            command.Mode,
            command.TargetItemId,
            command.ParentItemId,
            command.Title,
            command.IdempotencyKey,
            cancellationToken);
}
