using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Nix.Api.Errors;

/// <summary>
/// Teaches the OpenAPI document about the RFC 9457 extension members Nix always
/// sends. Without this the generated schema stops at the five standard fields and
/// the generated frontend client has no typed access to <c>code</c> — the one
/// field error handling is supposed to branch on.
/// </summary>
internal sealed class ProblemDetailsSchemaTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(schema);
        ArgumentNullException.ThrowIfNull(context);

        if (context.JsonTypeInfo.Type != typeof(ProblemDetails))
        {
            return Task.CompletedTask;
        }

        schema.Properties ??= new Dictionary<string, IOpenApiSchema>(StringComparer.Ordinal);

        schema.Properties[ApiProblem.CodeExtension] = new OpenApiSchema
        {
            Type = JsonSchemaType.String,
            Description =
                "Stable, machine-readable error code, namespaced by feature (for example "
                + "'health.check_not_found'). Clients branch on this value and never on 'title' "
                + "or 'detail', which are human-facing and may change.",
        };

        schema.Properties[ApiProblem.TraceIdExtension] = new OpenApiSchema
        {
            Type = JsonSchemaType.String,
            Description = "Identifier of the server-side trace that produced this failure.",
        };

        schema.Required ??= new HashSet<string>(StringComparer.Ordinal);
        schema.Required.Add(ApiProblem.CodeExtension);

        return Task.CompletedTask;
    }
}
