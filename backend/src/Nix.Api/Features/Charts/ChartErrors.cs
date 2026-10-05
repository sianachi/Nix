using Nix.Domain.Primitives;

namespace Nix.Features.Charts;

/// <summary>
/// The expected failures of the chart feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// Declared once here rather than constructed at call sites, because the code is the part clients
/// branch on. The literals live on <see cref="ChartEndpoints"/>, where the status mapping reads
/// them, so the guarantee does not depend on two files agreeing about a string.
/// </remarks>
public static class ChartErrors
{
    /// <summary>The item has no such chart view.</summary>
    /// <remarks>
    /// Covers both "no view with that id" and "a view with that id that is not a chart" - the
    /// detail tells them apart, the status does not need to. 404: the caller addressed a resource
    /// that is not there.
    /// </remarks>
    public static NixError ViewNotFound(string detail) =>
        new(ChartEndpoints.ViewNotFoundCode, detail);

    /// <summary>The stored chart is missing something it cannot be drawn without.</summary>
    /// <remarks>
    /// Refused rather than answered with empty buckets, which a view would draw as "there is
    /// nothing in here" - sending somebody looking for their missing items instead of their
    /// unfinished configuration. 422: the resource exists, its state cannot be processed.
    /// </remarks>
    public static NixError NotConfigured(string detail) =>
        new(ChartEndpoints.NotConfiguredCode, detail);
}
