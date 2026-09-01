using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Authorizes all body writes for one worker-owned template import stage.</summary>
public readonly record struct AuthorizeTemplateOperationWrites(TemplateOperationId OperationId)
    : IQuery<Result<TemplateOperationWriteAuthorization>>;

/// <summary>Delegates worker body-write authorization to the template boundary.</summary>
public sealed class AuthorizeTemplateOperationWritesHandler(ITemplateAuthorizationStore authorization)
    : IQueryHandler<AuthorizeTemplateOperationWrites, Result<TemplateOperationWriteAuthorization>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateOperationWriteAuthorization>> HandleAsync(
        AuthorizeTemplateOperationWrites query,
        CancellationToken cancellationToken) =>
        authorization.AuthorizeOperationWritesAsync(query.OperationId, cancellationToken);
}
