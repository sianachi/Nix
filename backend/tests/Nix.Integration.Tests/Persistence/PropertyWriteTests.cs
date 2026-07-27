using Nix.Application.Items;
using Nix.Application.Properties;
using Nix.Application.Views;
using Nix.Core.Items;
using Nix.Core.Properties;
using Nix.Core.Tenancy;
using Nix.Core.Views;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Writing property values, declaring schemas, and configuring views - through the use cases a
/// request reaches.
/// </summary>
/// <remarks>
/// The cascade has its own property test. What is left is everything around it: what a write
/// refuses, what it preserves, and what happens to stored values when the schema beneath them
/// changes. That last one is the promise ADR-0007 §4 makes, and it is the one most likely to be
/// broken by somebody making validation stricter for good reasons.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PropertyWriteTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public PropertyWriteTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_value_that_fits_the_schema_is_stored()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var written = await work.Resolve<SetItemProperties>()
                .ExecuteAsync(note.Id, """{"status":"Doing"}""", Cancellation);

            Assert.True(written.IsSuccess, written.IsSuccess ? "" : written.Error.Message);
            Assert.Contains("Doing", written.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_value_the_select_does_not_offer_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var written = await work.Resolve<SetItemProperties>()
                .ExecuteAsync(note.Id, """{"status":"Elsewhere"}""", Cancellation);

            Assert.True(written.IsFailure);
            Assert.Equal("properties.invalid", written.Error.Code);
        }
    }

    [Fact]
    public async Task A_write_merges_rather_than_replacing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var properties = work.Resolve<SetItemProperties>();

            await properties.ExecuteAsync(note.Id, """{"status":"Todo"}""", Cancellation);
            var second = await properties.ExecuteAsync(note.Id, """{"note":"a remark"}""", Cancellation);

            Assert.True(second.IsSuccess, second.IsSuccess ? "" : second.Error.Message);

            // A board dragging a card sends one property. Replacing the bag would drop every other
            // property the item carries - starting with its title, which lives in there too.
            Assert.Contains("Todo", second.Value.Properties, StringComparison.Ordinal);
            Assert.Contains("a remark", second.Value.Properties, StringComparison.Ordinal);
            Assert.Equal("Note", ItemProperties.ReadTitle(second.Value.Properties));
        }
    }

    [Fact]
    public async Task An_explicit_null_clears_a_property()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var properties = work.Resolve<SetItemProperties>();

            await properties.ExecuteAsync(note.Id, """{"status":"Todo"}""", Cancellation);
            var cleared = await properties.ExecuteAsync(note.Id, """{"status":null}""", Cancellation);

            Assert.True(cleared.IsSuccess, cleared.IsSuccess ? "" : cleared.Error.Message);
            Assert.DoesNotContain("Todo", cleared.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_required_property_must_be_supplied()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            await work.Resolve<SetItemSchema>().ExecuteAsync(
                folder.Id,
                new PropertySchema
                {
                    Inherit = true,
                    Properties = [new PropertyDefinition("owner", "Owner", PropertyType.Text, [], true)],
                },
                Cancellation);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var written = await work.Resolve<SetItemProperties>()
                .ExecuteAsync(note.Id, """{"note":"anything"}""", Cancellation);

            Assert.True(written.IsFailure);
            Assert.Contains("Owner", written.Error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Removing_a_property_from_a_schema_leaves_its_values_intact()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var properties = work.Resolve<SetItemProperties>();

            await properties.ExecuteAsync(note.Id, """{"status":"Doing"}""", Cancellation);

            // The schema is edited out from under the value.
            await work.Resolve<SetItemSchema>().ExecuteAsync(folder.Id, PropertySchema.Empty, Cancellation);

            // The value survives, and the next write to the item still succeeds. The alternative -
            // invalidating stored data because somebody edited a definition - would mean one schema
            // edit breaks the next write to every item beneath it, on data the writer never
            // touched. See ADR-0007 §4.
            var after = await properties.ExecuteAsync(note.Id, """{"note":"still fine"}""", Cancellation);

            Assert.True(after.IsSuccess, after.IsSuccess ? "" : after.Error.Message);
            Assert.Contains("Doing", after.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_schema_cannot_redeclare_the_title()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var declared = await work.Resolve<SetItemSchema>().ExecuteAsync(
                folder.Id,
                new PropertySchema
                {
                    Inherit = true,
                    Properties = [new PropertyDefinition("title", "Name", PropertyType.Text, [], true)],
                },
                Cancellation);

            // The title is promoted to a first-class field and written by the rename path. A schema
            // redeclaring it would give one value two owners with different rules.
            Assert.True(declared.IsFailure);
            Assert.Equal("schema.invalid", declared.Error.Code);
        }
    }

    [Fact]
    public async Task A_select_with_no_options_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var declared = await work.Resolve<SetItemSchema>().ExecuteAsync(
                folder.Id,
                new PropertySchema
                {
                    Inherit = true,
                    Properties = [new PropertyDefinition("stage", "Stage", PropertyType.Select, [], false)],
                },
                Cancellation);

            // It parses perfectly and then rejects every value anybody could give it, which looks
            // like a bug in the validator rather than an unfinished schema.
            Assert.True(declared.IsFailure);
            Assert.Equal("schema.invalid", declared.Error.Code);
        }
    }

    [Fact]
    public async Task Reading_a_schema_says_what_is_declared_here_and_what_is_inherited()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var child = await NewItemAsync(work, "Sub", folder.Id, "folder");

            var read = await work.Resolve<GetEffectiveSchema>().ExecuteAsync(child.Id, Cancellation);

            Assert.True(read.IsSuccess);

            // An editor shown only the merged result would save the inherited property back onto
            // the child, silently turning inheritance into a copy - after which changing the
            // parent's schema would stop reaching it.
            Assert.NotNull(read.Value.Effective.Find("status"));
            Assert.Null(read.Value.Declared.Find("status"));
            Assert.False(read.Value.DeclaresSchema);
        }
    }

    [Fact]
    public async Task A_board_grouping_by_a_deleted_property_reports_itself_unrenderable()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var stored = await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [
                    new ViewDefinition("by-status", "By status", ViewKind.Board, [], "status", [], null, null, false),
                ],
                null,
                Cancellation);

            Assert.True(stored.IsSuccess, stored.IsSuccess ? "" : stored.Error.Message);

            var whileValid = await work.Resolve<GetContainerViews>().ExecuteAsync(folder.Id, Cancellation);
            Assert.Empty(whileValid.Value.Unrenderable);

            await work.Resolve<SetItemSchema>().ExecuteAsync(folder.Id, PropertySchema.Empty, Cancellation);

            var afterDeletion = await work.Resolve<GetContainerViews>().ExecuteAsync(folder.Id, Cancellation);

            // Without this, the board renders empty - which is indistinguishable from an empty
            // folder, and sends somebody looking for their missing items rather than their missing
            // property.
            Assert.Contains("by-status", afterDeletion.Value.Unrenderable);
        }
    }

    [Fact]
    public async Task A_default_naming_a_view_that_is_not_being_stored_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            // Stored, it would resolve to the document on the very next read - so the person's
            // choice would appear to be taken and then quietly discarded. Refusing says so.
            var stored = await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false)],
                "some-other-view",
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task A_view_may_not_call_itself_the_document()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            // One field names either a view or the item's own body, so the word has to belong to
            // exactly one of them. Ids are slugs of names, and "Document" is a name somebody will
            // pick - without this it would become unreachable, shadowed by the body.
            var stored = await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [new ViewDefinition("document", "Document", ViewKind.List, [], null, [], null, null, false)],
                null,
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task The_view_that_opens_survives_storage()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [
                    new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false),
                    new ViewDefinition("by-status", "By status", ViewKind.Board, [], "status", [], null, null, false),
                ],
                "by-status",
                Cancellation);

            var read = await work.Resolve<GetContainerViews>().ExecuteAsync(folder.Id, Cancellation);

            Assert.True(read.IsSuccess);
            Assert.Equal("by-status", read.Value.Default);
        }
    }

    [Fact]
    public async Task A_container_with_no_views_opens_its_document()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var read = await work.Resolve<GetContainerViews>().ExecuteAsync(folder.Id, Cancellation);

            Assert.True(read.IsSuccess);
            Assert.Equal("document", read.Value.Default);
        }
    }

    [Fact]
    public async Task A_board_with_no_grouping_property_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var stored = await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [new ViewDefinition("b", "Board", ViewKind.Board, [], null, [], null, null, false)],
                null,
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task Views_round_trip_through_storage()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            await work.Resolve<SetContainerViews>().ExecuteAsync(
                folder.Id,
                [
                    new ViewDefinition("all", "All", ViewKind.List, ["status"], null, [], null, "status", true),
                    new ViewDefinition(
                        "by-status",
                        "By status",
                        ViewKind.Board,
                        [],
                        "status",
                        ["Doing", "Todo"],
                        null,
                        null,
                        false),
                ],
                null,
                Cancellation);

            var read = await work.Resolve<GetContainerViews>().ExecuteAsync(folder.Id, Cancellation);

            Assert.Equal(2, read.Value.Views.Length);
            Assert.Equal("All", read.Value.Views[0].Name);
            Assert.Equal(["status"], read.Value.Views[0].Columns);
            Assert.True(read.Value.Views[0].SortDescending);

            // The board's column order is the view's, not the schema's - the schema declares Todo
            // then Doing, and this board deliberately shows them the other way round.
            Assert.Equal(["Doing", "Todo"], read.Value.Views[1].GroupOrder);
        }
    }

    [Fact]
    public async Task A_schema_cannot_be_read_or_written_across_tenants()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var alphaItem = ItemId.From(M0SchemaSeed.Alpha.ItemId);

            var read = await work.Resolve<GetEffectiveSchema>().ExecuteAsync(alphaItem, Cancellation);
            Assert.Equal("items.not_found", read.Error.Code);

            var written = await work.Resolve<SetItemSchema>()
                .ExecuteAsync(alphaItem, PropertySchema.Empty, Cancellation);
            Assert.Equal("items.not_found", written.Error.Code);

            var views = await work.Resolve<GetContainerViews>().ExecuteAsync(alphaItem, Cancellation);
            Assert.Equal("items.not_found", views.Error.Code);
        }
    }

    private static async Task DeclareStatusAsync(NixUnitOfWork work, ItemId itemId)
    {
        var declared = await work.Resolve<SetItemSchema>().ExecuteAsync(
            itemId,
            new PropertySchema
            {
                Inherit = true,
                Properties =
                [
                    new PropertyDefinition(
                        "status",
                        "Status",
                        PropertyType.Select,
                        ["Todo", "Doing", "Done"],
                        false),
                ],
            },
            Cancellation);

        Assert.True(declared.IsSuccess, declared.IsSuccess ? "" : declared.Error.Message);
    }

    private static async Task<Item> NewItemAsync(
        NixUnitOfWork work,
        string title,
        ItemId? parentId,
        string type = "note")
    {
        var created = await work.Resolve<CreateItem>()
            .ExecuteAsync(Workspace, type, title, parentId, Cancellation);

        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }
}
