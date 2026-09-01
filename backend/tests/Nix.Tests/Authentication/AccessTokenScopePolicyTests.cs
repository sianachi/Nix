using System.Text.Json;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Tests.Harness;
using static Nix.Authentication.AccessTokenScopePolicy;

namespace Nix.Tests.Authentication;

/// <summary>
/// The scope ceiling's classification of every route, held exhaustive against the published
/// contract: an endpoint nobody classified is an endpoint this suite refuses to let ship.
/// </summary>
public sealed class AccessTokenScopePolicyTests
{
    /// <summary>
    /// Every operation in the contract, classified deliberately.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Adding an endpoint fails this test until its row is added here</b> - that is the
    /// mechanism, not an inconvenience. The policy classifies by shape, so a new route always
    /// gets an answer; this table is where a person confirms the answer is the intended one
    /// rather than an accident of its path.
    /// </para>
    /// <para>
    /// Routes outside <c>/api/v1</c> (health, the public form surface, the exchange itself)
    /// never pass through the unit-of-work middleware, so the policy never actually gates them -
    /// they are classified here anyway so the table stays a total function of the contract and
    /// a route that moves under <c>/api/v1</c> changes a row instead of appearing from nowhere.
    /// </para>
    /// </remarks>
    private static readonly Dictionary<string, Requirement> ExpectedByOperation = new(StringComparer.Ordinal)
    {
        // Reads: everything a read-only agent may do.
        ["GetHealthCheck"] = Requirement.Read,
        ["GetServiceStatus"] = Requirement.Read,
        ["GetLiveness"] = Requirement.Read,
        ["GetItem"] = Requirement.Read,
        ["GetFile"] = Requirement.Read,
        ["GetFileUpload"] = Requirement.Read,
        ["AuthorizeFileDownload"] = Requirement.Read,
        ["GetDocumentImport"] = Requirement.Read,
        ["AuthorizeDocumentImportPreview"] = Requirement.Read,
        ["ListExportFormats"] = Requirement.Read,
        ["GetExport"] = Requirement.Read,
        ["AuthorizeExportDownload"] = Requirement.Read,
        ["GetOperation"] = Requirement.Read,
        ["GetBacklinks"] = Requirement.Read,
        ["GetItemPermissions"] = Requirement.Read,
        ["RunItemQuery"] = Requirement.Read,

        // A summary of children the caller can already list. Nothing about a chart discloses more
        // than the listing beside it, so it is a read like the listing.
        ["RunItemChart"] = Requirement.Read,
        ["GetEffectiveSchema"] = Requirement.Read,
        ["GetContainerViews"] = Requirement.Read,
        ["GetCurrentPrincipal"] = Requirement.Read,
        ["GetBookmarks"] = Requirement.Read,
        ["GetCanvasLibrary"] = Requirement.Read,
        ["SearchItems"] = Requirement.Read,
        ["ResolveReferences"] = Requirement.Read,
        ["ListTenantRoles"] = Requirement.Read,
        ["ListWorkspaces"] = Requirement.Read,
        ["GetWorkspace"] = Requirement.Read,
        ["GetWorkspaceCalendar"] = Requirement.Read,
        ["GetWorkspaceGraph"] = Requirement.Read,
        ["ListItems"] = Requirement.Read,
        ["ListWorkspaceMembers"] = Requirement.Read,
        ["ListWorkspaceInvitations"] = Requirement.Read,
        ["GetAccessTokenSigningKeys"] = Requirement.Read,
        ["GetPublicForm"] = Requirement.Read,
        ["ListTemplates"] = Requirement.Read,
        ["GetTemplate"] = Requirement.Read,
        ["GetTemplateItem"] = Requirement.Read,
        ["ListWorkspacePlugins"] = Requirement.Read,

        // Writes: content and structure, but never who-sees-what.
        ["UpdateItem"] = Requirement.Write,
        ["DeleteItem"] = Requirement.Write,
        ["KeepItem"] = Requirement.Write,
        ["ReleaseItem"] = Requirement.Write,
        // Both recurrence writes are ordinary item edits under a token's write scope: setting a
        // rule changes what an item does, and completing an occurrence records work against it.
        // Neither is administrative - a token that may edit an item may schedule it.
        ["SetItemRecurrence"] = Requirement.Write,
        ["CompleteRecurrenceOccurrence"] = Requirement.Write,
        ["SetItemProperties"] = Requirement.Write,
        ["RestoreItem"] = Requirement.Write,
        ["SetItemSchema"] = Requirement.Write,
        ["AppendViewSetup"] = Requirement.Write,
        ["ReplaceViewSetup"] = Requirement.Write,
        ["SetContainerViews"] = Requirement.Write,
        ["SaveCanvasLibrary"] = Requirement.Write,
        ["CreateItem"] = Requirement.Write,
        ["CreateStructuredItem"] = Requirement.Write,
        ["SubmitPublicForm"] = Requirement.Write,
        ["ExchangeAccessToken"] = Requirement.Write,
        ["DeleteTemplate"] = Requirement.Write,
        ["CreateWorkspace"] = Requirement.Write,
        ["RenameWorkspace"] = Requirement.Write,
        ["OpenDailyNote"] = Requirement.Write,
        ["BeginFileUpload"] = Requirement.Write,
        ["CompleteFileUpload"] = Requirement.Write,
        ["CancelFileUpload"] = Requirement.Write,
        ["BeginDocumentImport"] = Requirement.Write,
        ["PreviewDocumentImport"] = Requirement.Write,
        ["CommitDocumentImport"] = Requirement.Write,
        ["CancelDocumentImport"] = Requirement.Write,
        ["BeginExport"] = Requirement.Write,
        ["CancelExport"] = Requirement.Write,
        ["CancelOperation"] = Requirement.Write,

        // A POST that only previews an application; classified Write because it is not a GET, which
        // over-restricts a read-only token from previewing rather than under-restricting - the
        // policy's deliberate one-sided failure mode.
        ["PreflightTemplateApplication"] = Requirement.Write,

        // Admin: what changes or exposes who can see what - permission entries, the public-link
        // surface whichever method reaches it (its GET reads back a live anonymous-write URL), and
        // a move, which re-parents an item into another audience through inheritance.
        ["UpsertAclEntry"] = Requirement.Admin,
        ["DeleteAclEntry"] = Requirement.Admin,
        ["GetPublicFormStatus"] = Requirement.Admin,
        ["PublishPublicForm"] = Requirement.Admin,
        ["RevokePublicForm"] = Requirement.Admin,
        ["MoveItem"] = Requirement.Admin,
        ["CreateWorkspaceInvitation"] = Requirement.Admin,
        ["ListWorkspaceInvitees"] = Requirement.Admin,
        ["RevokeWorkspaceInvitation"] = Requirement.Admin,
        ["AcceptWorkspaceInvitation"] = Requirement.Admin,
        ["DeclineWorkspaceInvitation"] = Requirement.Admin,
        ["ChangeWorkspaceMemberRole"] = Requirement.Admin,
        ["RemoveWorkspaceMember"] = Requirement.Admin,
        ["LeaveWorkspace"] = Requirement.Admin,
        ["RecoverWorkspace"] = Requirement.Admin,
        ["BeginPluginComponentUpload"] = Requirement.Admin,
        ["RegisterWorkspacePlugin"] = Requirement.Admin,
        ["SetWorkspacePluginEnabled"] = Requirement.Admin,
        ["ReplaceWorkspacePluginCapabilities"] = Requirement.Admin,

        // A token never manages tokens, whatever it holds.
        ["ListAccessTokens"] = Requirement.InteractiveOnly,
        ["CreateAccessToken"] = Requirement.InteractiveOnly,
        ["RevokeAccessToken"] = Requirement.InteractiveOnly,
    };

    [Fact]
    public void Every_operation_in_the_contract_is_classified_and_classified_as_intended()
    {
        var contract = JsonDocument.Parse(File.ReadAllText(PublishedContract.Path()));
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var path in contract.RootElement.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                if (!IsHttpMethod(operation.Name))
                {
                    continue;
                }

                var operationId = operation.Value.GetProperty("operationId").GetString();
                Assert.False(string.IsNullOrEmpty(operationId), $"{path.Name} has no operationId.");
                Assert.True(
                    ExpectedByOperation.TryGetValue(operationId, out var expected),
                    $"Operation '{operationId}' ({operation.Name.ToUpperInvariant()} {path.Name}) "
                    + "is not classified. Add it to ExpectedByOperation with the scope a personal "
                    + "access token must hold - this table is where that decision is made "
                    + "deliberately.");

                var actual = Classify(operation.Name.ToUpperInvariant(), path.Name);
                Assert.True(
                    expected == actual,
                    $"Operation '{operationId}' classifies as {actual}, but the table says "
                    + $"{expected}. One of them is wrong; decide which.");

                seen.Add(operationId!);
            }
        }

        // Both directions: a row for an operation the contract no longer has is a stale decision.
        var stale = ExpectedByOperation.Keys.Except(seen, StringComparer.Ordinal).ToList();
        Assert.True(stale.Count == 0, "Classified but not in the contract: " + string.Join(", ", stale));
    }

    [Theory]
    [InlineData("GET", "/api/v1/me/tokens")]
    [InlineData("POST", "/api/v1/me/tokens")]
    [InlineData("DELETE", "/api/v1/me/tokens/00000000-0000-0000-0000-000000000001")]
    public void No_scope_admits_a_token_to_token_management(string method, string path)
    {
        var requirement = Classify(method, path);

        Assert.Equal(Requirement.InteractiveOnly, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin], requirement));
    }

    [Fact]
    public void Scopes_are_independent_rather_than_ordered()
    {
        Assert.True(Satisfies([AccessTokenScopes.Read], Requirement.Read));
        Assert.False(Satisfies([AccessTokenScopes.Read], Requirement.Write));
        Assert.False(Satisfies([AccessTokenScopes.Write], Requirement.Read));
        Assert.False(Satisfies([AccessTokenScopes.Admin], Requirement.Write));
        Assert.True(Satisfies([AccessTokenScopes.Admin], Requirement.Admin));
    }

    [Fact]
    public void A_scope_spelling_this_build_cannot_interpret_grants_nothing()
    {
        Assert.False(Satisfies(["READ"], Requirement.Read));
        Assert.False(Satisfies(["everything"], Requirement.Read));
        Assert.False(Satisfies([], Requirement.Read));
    }

    [Fact]
    public void Permission_writes_need_admin_even_for_a_write_scoped_token()
    {
        var requirement = Classify(
            "PUT",
            "/api/v1/items/00000000-0000-0000-0000-000000000001/permissions/entries");

        Assert.Equal(Requirement.Admin, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write], requirement));
    }

    private static bool IsHttpMethod(string name) => name is
        "get" or "put" or "post" or "delete" or "patch" or "head" or "options";
}
