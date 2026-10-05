using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Templates;

/// <summary>Resolves caller-scoped authorization for internal template workflows.</summary>
public interface ITemplateAuthorizationStore
{
    public ValueTask<Result<TemplateWorkspaceAuthorization>> AuthorizeImportAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateOperationAuthorization>> AuthorizeOperationItemAsync(
        Guid operationId,
        ItemId itemId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateOperationWriteAuthorization>> AuthorizeOperationWritesAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateItemAuthorization>> AuthorizeTemplateItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken);
}
