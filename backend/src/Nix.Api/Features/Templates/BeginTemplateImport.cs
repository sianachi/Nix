using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Begins staging a validated template archive.</summary>
public readonly record struct BeginTemplateImport(
    WorkspaceId WorkspaceId,
    string IdempotencyKey,
    TemplateImportDescriptor Descriptor,
    IReadOnlyList<TemplateImportItem> Items) : ICommand<TemplateImportPlan>;

/// <summary>Begins staging a validated template archive.</summary>
public sealed class BeginTemplateImportHandler(ITemplateStagingStore stages)
    : ICommandHandler<BeginTemplateImport, TemplateImportPlan>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateImportPlan>> HandleAsync(
        BeginTemplateImport command,
        CancellationToken cancellationToken) =>
        stages.BeginImportAsync(
            command.WorkspaceId,
            command.IdempotencyKey,
            command.Descriptor,
            command.Items,
            cancellationToken);
}
