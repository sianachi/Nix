using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.TemplateImports;

/// <summary>The problem details every template import route answers with.</summary>
internal static class TemplateImportProblems
{
    internal static ProblemHttpResult TemplateProblem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            "templates.not_found" => StatusCodes.Status404NotFound,
            "templates.forbidden" => StatusCodes.Status403Forbidden,
            "templates.invalid" => StatusCodes.Status422UnprocessableEntity,
            _ => StatusCodes.Status409Conflict,
        };
        return TypedResults.Problem(ApiProblem.Create(
            context,
            status,
            error.Code,
            "Template import refused",
            error.Message));
    }

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails NotFound(HttpContext context) =>
        ApiProblem.Create(context, 404, "templates.import_not_found", "Template import not found", "No such template import is visible.");

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Invalid(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 400, code, "Template import refused", detail);

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Conflict(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 409, code, "Template import conflict", detail);

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails ExecutionLost(HttpContext context) =>
        ApiProblem.Create(context, 409, "worker.execution_refused", "Worker execution refused", "The worker no longer owns a live execution for this job.");

    internal static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            503,
            "templates.storage_not_configured",
            "Template import storage unavailable",
            "Private object storage is not configured for this deployment."));
}
