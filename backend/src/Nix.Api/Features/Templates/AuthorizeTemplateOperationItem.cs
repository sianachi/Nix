using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Authorizes body access to one staged operation item.</summary>
public readonly record struct AuthorizeTemplateOperationItem(Guid OperationId, ItemId ItemId)
    : IQuery<Result<TemplateOperationAuthorization>>;

/// <summary>Authorizes body access to one staged operation item.</summary>
public sealed class AuthorizeTemplateOperationItemHandler(ITemplateAuthorizationStore authorization)
    : IQueryHandler<AuthorizeTemplateOperationItem, Result<TemplateOperationAuthorization>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateOperationAuthorization>> HandleAsync(
        AuthorizeTemplateOperationItem query,
        CancellationToken cancellationToken) =>
        authorization.AuthorizeOperationItemAsync(query.OperationId, query.ItemId, cancellationToken);
}
