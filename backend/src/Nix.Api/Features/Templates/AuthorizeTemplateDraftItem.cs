using Nix.Abstractions.Templates;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Authorizes body access to one draft item.</summary>
public readonly record struct AuthorizeTemplateDraftItem(
    TemplateId TemplateId,
    TemplateOperationId OperationId,
    Guid SourceId) : IQuery<Result<TemplateItemAuthorization>>;

/// <summary>Authorizes body access to one draft item.</summary>
public sealed class AuthorizeTemplateDraftItemHandler(ITemplateDraftStore drafts)
    : IQueryHandler<AuthorizeTemplateDraftItem, Result<TemplateItemAuthorization>>
{
    /// <inheritdoc />
    public ValueTask<Result<TemplateItemAuthorization>> HandleAsync(
        AuthorizeTemplateDraftItem query,
        CancellationToken cancellationToken) =>
        drafts.AuthorizeDraftItemAsync(
            query.TemplateId,
            query.OperationId,
            query.SourceId,
            cancellationToken);
}
