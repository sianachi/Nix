using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Errors;

namespace Nix.Features.DocumentImports;

/// <summary>The problem details every document import route answers with.</summary>
internal static class DocumentImportProblems
{
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails NotFound(HttpContext context) =>
        ApiProblem.Create(context, 404, "imports.not_found", "Import not found", "No such import is visible.");

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Invalid(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 400, code, "Import refused", detail);

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Conflict(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 409, code, "Import conflict", detail);

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails ExecutionLost(HttpContext context) =>
        ApiProblem.Create(context, 409, "worker.execution_refused", "Worker execution refused", "The worker no longer owns a live execution for this job.");

    internal static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            503,
            "imports.storage_not_configured",
            "Import storage unavailable",
            "Private object storage is not configured for this deployment."));
}
