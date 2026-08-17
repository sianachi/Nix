using Nix.Domain.Primitives;
using Nix.Domain.Templates;

namespace Nix.Abstractions.Templates;

/// <summary>Runs the staged template-edit workflow.</summary>
public interface ITemplateDraftStore
{
    public ValueTask<Result<TemplateDraftPlan>> BeginDraftAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateDraftPlan>> DraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateDraftPlan>> UpdateDraftMetadataAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        string? title,
        string? description,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateItemSnapshot>> UpdateDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        string? title,
        string? properties,
        string? schema,
        string? views,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateId>> SaveDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateItemAuthorization>> AuthorizeDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        CancellationToken cancellationToken);
}
