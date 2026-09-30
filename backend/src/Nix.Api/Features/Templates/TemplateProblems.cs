using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Templates;

namespace Nix.Features.Templates;

/// <summary>Maps a template refusal onto the problem details the public and internal template routes answer with.</summary>
internal static class TemplateProblems
{
    internal static ProblemHttpResult Refused(
        HttpContext context,
        NixError error)
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
            "Template request refused",
            error.Message));
    }
}
