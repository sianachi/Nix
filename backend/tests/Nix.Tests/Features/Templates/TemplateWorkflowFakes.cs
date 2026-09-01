using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Templates;

namespace Nix.Tests.Features.Templates;

internal abstract class TemplateWorkflowFake
{
    internal NixError Refusal { get; } = new("test.template_refusal", "The test port refused the request.");

    internal object? LastRequest { get; private protected set; }

    internal CancellationToken LastCancellationToken { get; private protected set; }

    protected ValueTask<Result<T>> Refuse<T>(object request, CancellationToken cancellationToken)
    {
        LastRequest = request;
        LastCancellationToken = cancellationToken;
        return ValueTask.FromResult(Result.Failure<T>(Refusal));
    }
}

internal sealed class FakeTemplateCatalogStore : TemplateWorkflowFake, ITemplateCatalogStore
{
    public ValueTask<Result<TemplateLibrarySnapshot>> ListAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateLibrarySnapshot>(new ListTemplates(workspaceId), cancellationToken);

    public ValueTask<Result<TemplateDetailSnapshot>> DetailAsync(
        TemplateId templateId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateDetailSnapshot>(new GetTemplate(templateId), cancellationToken);

    public ValueTask<Result<TemplateItemSnapshot>> ItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateItemSnapshot>(new GetTemplateItem(templateId, sourceId), cancellationToken);

    public ValueTask<Result<bool>> DeleteAsync(
        TemplateId templateId,
        CancellationToken cancellationToken) =>
        Refuse<bool>(new DeleteTemplate(templateId), cancellationToken);

    public ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        CancellationToken cancellationToken) =>
        Refuse<TemplatePreflight>(
            new PreflightTemplateApplication(templateId, mode, targetItemId, parentItemId),
            cancellationToken);

    public ValueTask<Result<TemplateExportSnapshot>> ExportAsync(
        TemplateId templateId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateExportSnapshot>(new ExportTemplate(templateId), cancellationToken);
}

internal sealed class FakeTemplateDraftStore : TemplateWorkflowFake, ITemplateDraftStore
{
    internal Result<TemplateDraftPlan>? DraftResult { get; set; }

    public ValueTask<Result<TemplateDraftPlan>> BeginDraftAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken) =>
        Refuse<TemplateDraftPlan>(new BeginTemplateDraft(templateId, idempotencyKey), cancellationToken);

    public ValueTask<Result<TemplateDraftPlan>> DraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var request = new GetTemplateDraft(templateId, operationId);
        if (DraftResult is not { } result)
        {
            return Refuse<TemplateDraftPlan>(request, cancellationToken);
        }

        LastRequest = request;
        LastCancellationToken = cancellationToken;
        return ValueTask.FromResult(result);
    }

    public ValueTask<Result<TemplateDraftPlan>> UpdateDraftMetadataAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        string? title,
        string? description,
        CancellationToken cancellationToken) =>
        Refuse<TemplateDraftPlan>(
            new UpdateTemplateDraft(templateId, operationId, title, description),
            cancellationToken);

    public ValueTask<Result<TemplateItemSnapshot>> UpdateDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        string? title,
        string? properties,
        string? schema,
        string? views,
        CancellationToken cancellationToken) =>
        Refuse<TemplateItemSnapshot>(
            new UpdateTemplateDraftItem(
                templateId,
                operationId,
                sourceId,
                title,
                properties,
                schema,
                views),
            cancellationToken);

    public ValueTask<Result<TemplateId>> SaveDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateId>(new SaveTemplateDraft(templateId, operationId), cancellationToken);

    public ValueTask<Result<TemplateItemAuthorization>> AuthorizeDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateItemAuthorization>(
            new AuthorizeTemplateDraftItem(templateId, operationId, sourceId),
            cancellationToken);
}

internal sealed class FakeTemplateStagingStore : TemplateWorkflowFake, ITemplateStagingStore
{
    public ValueTask<Result<TemplateCapturePlan>> BeginCaptureAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        string title,
        string? description,
        bool includeBody,
        bool includeChildren,
        string idempotencyKey,
        CancellationToken cancellationToken) =>
        Refuse<TemplateCapturePlan>(
            new BeginTemplateCapture(
                workspaceId,
                sourceItemId,
                title,
                description,
                includeBody,
                includeChildren,
                idempotencyKey),
            cancellationToken);

    public ValueTask<Result<TemplateImportPlan>> BeginImportAsync(
        WorkspaceId workspaceId,
        string idempotencyKey,
        TemplateImportDescriptor descriptor,
        IReadOnlyList<TemplateImportItem> items,
        CancellationToken cancellationToken) =>
        Refuse<TemplateImportPlan>(
            new BeginTemplateImport(workspaceId, idempotencyKey, descriptor, items),
            cancellationToken);

    public ValueTask<Result<TemplateId>> FinalizeOperationAsync(
        TemplateOperationId operationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken) =>
        Refuse<TemplateId>(
            new FinalizeTemplateOperation(operationId, writtenBodyItemIds),
            cancellationToken);

    public ValueTask<Result<bool>> AbortOperationAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken) =>
        Refuse<bool>(new AbortTemplateOperation(operationId), cancellationToken);
}

internal sealed class FakeTemplateApplicationStore : TemplateWorkflowFake, ITemplateApplicationStore
{
    public ValueTask<Result<TemplateApplicationPlan>> BeginApplicationAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        string idempotencyKey,
        CancellationToken cancellationToken) =>
        Refuse<TemplateApplicationPlan>(
            new BeginTemplateApplication(
                templateId,
                mode,
                targetItemId,
                parentItemId,
                title,
                idempotencyKey),
            cancellationToken);

    public ValueTask<Result<ItemId>> FinalizeApplicationAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken) =>
        Refuse<ItemId>(
            new FinalizeTemplateApplication(applicationId, writtenBodyItemIds),
            cancellationToken);

    public ValueTask<Result<bool>> AbortApplicationAsync(
        TemplateApplicationId applicationId,
        CancellationToken cancellationToken) =>
        Refuse<bool>(new AbortTemplateApplication(applicationId), cancellationToken);
}

internal sealed class FakeTemplateManagedStore : TemplateWorkflowFake, ITemplateManagedStore
{
    public ValueTask<Result<ManagedTemplateBatchResult>> FinalizeManagedBatchAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ManagedTemplateFinalization> managedEntries,
        IReadOnlyList<string> activeStableKeys,
        CancellationToken cancellationToken) =>
        Refuse<ManagedTemplateBatchResult>(
            new FinalizeManagedTemplates(workspaceId, managedEntries, activeStableKeys),
            cancellationToken);

    public ValueTask<Result<TemplateStageSweepResult>> SweepExpiredAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateStageSweepResult>(
            new SweepExpiredTemplateStages(workspaceId),
            cancellationToken);
}

internal sealed class FakeTemplateAuthorizationStore : TemplateWorkflowFake, ITemplateAuthorizationStore
{
    public ValueTask<Result<TemplateWorkspaceAuthorization>> AuthorizeImportAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateWorkspaceAuthorization>(new AuthorizeTemplateImport(workspaceId), cancellationToken);

    public ValueTask<Result<TemplateOperationAuthorization>> AuthorizeOperationItemAsync(
        Guid operationId,
        ItemId itemId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateOperationAuthorization>(
            new AuthorizeTemplateOperationItem(operationId, itemId),
            cancellationToken);

    public ValueTask<Result<TemplateOperationWriteAuthorization>> AuthorizeOperationWritesAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateOperationWriteAuthorization>(
            new AuthorizeTemplateOperationWrites(operationId),
            cancellationToken);

    public ValueTask<Result<TemplateItemAuthorization>> AuthorizeTemplateItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken) =>
        Refuse<TemplateItemAuthorization>(
            new AuthorizeTemplateItem(templateId, sourceId),
            cancellationToken);
}
