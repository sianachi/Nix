using Nix.Domain.Primitives;

namespace Nix.Features.Search;

/// <summary>
/// The expected failures of the search feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// Declared once here rather than constructed at each call site, because the code is the part
/// clients branch on and a typo in one of them is a bug nobody notices until a frontend stops
/// handling a case it used to.
///
/// The literals themselves live on <see cref="SearchEndpoints"/>, which is where the status mapping
/// reads them. Spelled out in both places - as they were - the guarantee this class exists to give
/// would have depended on two files agreeing about a string.
/// </remarks>
public static class SearchErrors
{
    /// <summary>No such item, or the caller cannot see it.</summary>
    /// <remarks>
    /// Deliberately the same code the items feature uses. A backlinks read is a read of an item,
    /// and a client that already knows how to handle "that item is not visible" should not need a
    /// second branch because the fact arrived through a different route.
    /// </remarks>
    public static NixError NotFound(string detail) => new(SearchEndpoints.NotFoundCode, detail);

    /// <summary>One request named more references than may be resolved at once.</summary>
    public static NixError TooManyReferences(string detail) =>
        new(SearchEndpoints.TooManyReferencesCode, detail);

    /// <summary>A value in the identifier list is not an identifier.</summary>
    public static NixError MalformedReferences(string detail) =>
        new(SearchEndpoints.MalformedReferencesCode, detail);
}
