using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Authorizes body access to one active template item.</summary>
public readonly record struct AuthorizeTemplateItem(TemplateId TemplateId, Guid SourceId)
    : IQuery<Result<TemplateItemAuthorization>>;

/// <summary>Authorizes body access to one active template item.</summary>
public sealed class AuthorizeTemplateItemHandler(ITemplateAuthorizationStore authorization)
    : IQueryHandler<AuthorizeTemplateItem, Result<TemplateItemAuthorization>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateItemAuthorization>> HandleAsync(
        AuthorizeTemplateItem query,
        CancellationToken cancellationToken) =>
        authorization.AuthorizeTemplateItemAsync(query.TemplateId, query.SourceId, cancellationToken);
}
