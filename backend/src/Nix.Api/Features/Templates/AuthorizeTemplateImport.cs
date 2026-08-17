using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Authorizes import admission for one workspace.</summary>
public readonly record struct AuthorizeTemplateImport(WorkspaceId WorkspaceId)
    : IQuery<Result<TemplateWorkspaceAuthorization>>;

/// <summary>Authorizes import admission for one workspace.</summary>
public sealed class AuthorizeTemplateImportHandler(ITemplateAuthorizationStore authorization)
    : IQueryHandler<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateWorkspaceAuthorization>> HandleAsync(
        AuthorizeTemplateImport query,
        CancellationToken cancellationToken) =>
        authorization.AuthorizeImportAsync(query.WorkspaceId, cancellationToken);
}
