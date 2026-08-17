using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Templates;

namespace Nix.Tests.Features.Templates;

public sealed class TemplateHandlerDelegationTests
{
    private static readonly WorkspaceId WorkspaceId = Nix.Domain.Tenancy.WorkspaceId.From(
        Guid.Parse("10000000-0000-4000-8000-000000000001"));
    private static readonly TemplateId TemplateId = Nix.Domain.Templates.TemplateId.From(
        Guid.Parse("20000000-0000-4000-8000-000000000002"));
    private static readonly TemplateOperationId OperationId = TemplateOperationId.From(
        Guid.Parse("30000000-0000-4000-8000-000000000003"));
    private static readonly TemplateApplicationId ApplicationId = TemplateApplicationId.From(
        Guid.Parse("40000000-0000-4000-8000-000000000004"));
    private static readonly ItemId ItemId = Nix.Domain.Items.ItemId.From(
        Guid.Parse("50000000-0000-4000-8000-000000000005"));
    private static readonly ItemId ParentId = Nix.Domain.Items.ItemId.From(
        Guid.Parse("60000000-0000-4000-8000-000000000006"));
    private static readonly Guid SourceId = Guid.Parse("70000000-0000-4000-8000-000000000007");

    [Fact]
    public async Task Catalog_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateCatalogStore();

        var list = new ListTemplates(WorkspaceId);
        await AssertDelegatesAsync(list, fake, () => new ListTemplatesHandler(fake).HandleAsync(list, token), token);

        var get = new GetTemplate(TemplateId);
        await AssertDelegatesAsync(get, fake, () => new GetTemplateHandler(fake).HandleAsync(get, token), token);

        var item = new GetTemplateItem(TemplateId, SourceId);
        await AssertDelegatesAsync(item, fake, () => new GetTemplateItemHandler(fake).HandleAsync(item, token), token);

        var delete = new DeleteTemplate(TemplateId);
        await AssertDelegatesAsync(delete, fake, () => new DeleteTemplateHandler(fake).HandleAsync(delete, token), token);

        var preflight = new PreflightTemplateApplication(
            TemplateId,
            TemplateApplicationMode.Merge,
            ItemId,
            ParentId);
        await AssertDelegatesAsync(
            preflight,
            fake,
            () => new PreflightTemplateApplicationHandler(fake).HandleAsync(preflight, token),
            token);

        var export = new ExportTemplate(TemplateId);
        await AssertDelegatesAsync(export, fake, () => new ExportTemplateHandler(fake).HandleAsync(export, token), token);
    }

    [Fact]
    public async Task Draft_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateDraftStore();

        var begin = new BeginTemplateDraft(TemplateId, "begin-draft");
        await AssertDelegatesAsync(begin, fake, () => new BeginTemplateDraftHandler(fake).HandleAsync(begin, token), token);

        var get = new GetTemplateDraft(TemplateId, OperationId);
        await AssertDelegatesAsync(get, fake, () => new GetTemplateDraftHandler(fake).HandleAsync(get, token), token);

        var update = new UpdateTemplateDraft(TemplateId, OperationId, "New title", "New description");
        await AssertDelegatesAsync(
            update,
            fake,
            () => new UpdateTemplateDraftHandler(fake).HandleAsync(update, token),
            token);

        var updateItem = new UpdateTemplateDraftItem(
            TemplateId,
            OperationId,
            SourceId,
            "Question",
            "{\"title\":\"Question\"}",
            "{\"inherit\":true,\"properties\":[]}",
            "{\"views\":[]}");
        await AssertDelegatesAsync(
            updateItem,
            fake,
            () => new UpdateTemplateDraftItemHandler(fake).HandleAsync(updateItem, token),
            token);

        var authorize = new AuthorizeTemplateDraftItem(TemplateId, OperationId, SourceId);
        await AssertDelegatesAsync(
            authorize,
            fake,
            () => new AuthorizeTemplateDraftItemHandler(fake).HandleAsync(authorize, token),
            token);

        var save = new SaveTemplateDraft(TemplateId, OperationId);
        await AssertDelegatesAsync(save, fake, () => new SaveTemplateDraftHandler(fake).HandleAsync(save, token), token);
    }

    [Fact]
    public async Task Discard_handler_verifies_the_draft_then_delegates_the_abort()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var drafts = new FakeTemplateDraftStore
        {
            DraftResult = Result.Success(DraftPlan()),
        };
        var stages = new FakeTemplateStagingStore();
        var command = new DiscardTemplateDraft(TemplateId, OperationId);

        var result = await new DiscardTemplateDraftHandler(drafts, stages)
            .HandleAsync(command, token);

        Assert.Equal(new GetTemplateDraft(TemplateId, OperationId), drafts.LastRequest);
        Assert.Equal(token, drafts.LastCancellationToken);
        Assert.Equal(new AbortTemplateOperation(OperationId), stages.LastRequest);
        Assert.Equal(token, stages.LastCancellationToken);
        Assert.Equal(stages.Refusal, result.Error);
    }

    [Fact]
    public async Task Staging_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateStagingStore();

        var capture = new BeginTemplateCapture(
            WorkspaceId,
            ItemId,
            "Captured",
            "Description",
            true,
            true,
            "capture-key");
        await AssertDelegatesAsync(
            capture,
            fake,
            () => new BeginTemplateCaptureHandler(fake).HandleAsync(capture, token),
            token);

        var descriptor = new TemplateImportDescriptor(
            "portable.template",
            "Portable",
            null,
            TemplateOrigin.User,
            null,
            new string('a', 64),
            false,
            true);
        TemplateImportItem[] items =
        [
            new(SourceId, null, "note", "Portable", 1, null, null, null, false),
        ];
        var import = new BeginTemplateImport(WorkspaceId, "import-key", descriptor, items);
        await AssertDelegatesAsync(
            import,
            fake,
            () => new BeginTemplateImportHandler(fake).HandleAsync(import, token),
            token);

        ItemId[] written = [ItemId, ParentId];
        var finalize = new FinalizeTemplateOperation(OperationId, written);
        await AssertDelegatesAsync(
            finalize,
            fake,
            () => new FinalizeTemplateOperationHandler(fake).HandleAsync(finalize, token),
            token);

        var abort = new AbortTemplateOperation(OperationId);
        await AssertDelegatesAsync(
            abort,
            fake,
            () => new AbortTemplateOperationHandler(fake).HandleAsync(abort, token),
            token);
    }

    [Fact]
    public async Task Application_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateApplicationStore();

        var begin = new BeginTemplateApplication(
            TemplateId,
            TemplateApplicationMode.Create,
            ItemId,
            ParentId,
            "Created",
            "application-key");
        await AssertDelegatesAsync(
            begin,
            fake,
            () => new BeginTemplateApplicationHandler(fake).HandleAsync(begin, token),
            token);

        ItemId[] written = [ItemId, ParentId];
        var finalize = new FinalizeTemplateApplication(ApplicationId, written);
        await AssertDelegatesAsync(
            finalize,
            fake,
            () => new FinalizeTemplateApplicationHandler(fake).HandleAsync(finalize, token),
            token);

        var abort = new AbortTemplateApplication(ApplicationId);
        await AssertDelegatesAsync(
            abort,
            fake,
            () => new AbortTemplateApplicationHandler(fake).HandleAsync(abort, token),
            token);
    }

    [Fact]
    public async Task Managed_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateManagedStore();
        ManagedTemplateFinalization[] entries =
        [
            new(OperationId, TemplateId, "managed.one", new string('b', 64), [ItemId]),
        ];
        string[] activeKeys = ["managed.one"];

        var finalize = new FinalizeManagedTemplates(WorkspaceId, entries, activeKeys);
        await AssertDelegatesAsync(
            finalize,
            fake,
            () => new FinalizeManagedTemplatesHandler(fake).HandleAsync(finalize, token),
            token);

        var sweep = new SweepExpiredTemplateStages(WorkspaceId);
        await AssertDelegatesAsync(
            sweep,
            fake,
            () => new SweepExpiredTemplateStagesHandler(fake).HandleAsync(sweep, token),
            token);
    }

    [Fact]
    public async Task Authorization_handlers_delegate_the_exact_request_and_result()
    {
        using var cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        var fake = new FakeTemplateAuthorizationStore();

        var import = new AuthorizeTemplateImport(WorkspaceId);
        await AssertDelegatesAsync(
            import,
            fake,
            () => new AuthorizeTemplateImportHandler(fake).HandleAsync(import, token),
            token);

        var operationItem = new AuthorizeTemplateOperationItem(OperationId.Value, ItemId);
        await AssertDelegatesAsync(
            operationItem,
            fake,
            () => new AuthorizeTemplateOperationItemHandler(fake).HandleAsync(operationItem, token),
            token);

        var item = new AuthorizeTemplateItem(TemplateId, SourceId);
        await AssertDelegatesAsync(
            item,
            fake,
            () => new AuthorizeTemplateItemHandler(fake).HandleAsync(item, token),
            token);
    }

    private static async ValueTask AssertDelegatesAsync<T>(
        object expectedRequest,
        TemplateWorkflowFake fake,
        Func<ValueTask<Result<T>>> invoke,
        CancellationToken cancellationToken)
    {
        var result = await invoke();

        Assert.Equal(expectedRequest, fake.LastRequest);
        Assert.Equal(cancellationToken, fake.LastCancellationToken);
        Assert.Equal(fake.Refusal, result.Error);
    }

    private static TemplateDraftPlan DraftPlan() =>
        new(
            OperationId,
            TemplateId,
            "Draft",
            null,
            DateTimeOffset.Parse("2026-08-17T12:00:00+00:00", System.Globalization.CultureInfo.InvariantCulture),
            new TemplateItemSnapshot(SourceId, "note", "Draft", 1, null, null, null, false, []),
            [],
            []);
}
