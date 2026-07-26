using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Nix.Api.Features.Health;

namespace Nix.Api.Serialization;

/// <summary>
/// The API's only JSON contract source. Every type that crosses the HTTP boundary
/// is declared here so serialization is source-generated: no reflection, no
/// runtime contract discovery on a request path (engineering plan section 3.2).
/// </summary>
/// <remarks>
/// <para>
/// <c>Program</c> installs this as the sole <c>TypeInfoResolver</c> for HTTP JSON,
/// replacing the reflection-based default outright. That is deliberate: a DTO that
/// someone forgets to register fails loudly the first time it is serialized rather
/// than silently falling back to reflection. Adding a response type to a feature
/// therefore means adding one <c>JsonSerializable</c> line here.
/// </para>
/// <para>
/// <c>string</c> is registered because <c>ProblemDetails.Extensions</c> is an
/// <c>IDictionary&lt;string, object?&gt;</c> whose values are serialized by their
/// runtime type; the <c>code</c> and <c>traceId</c> extensions are strings.
/// </para>
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LivenessResponse))]
[JsonSerializable(typeof(ServiceStatusResponse))]
[JsonSerializable(typeof(HealthCheckResponse))]
[JsonSerializable(typeof(ProblemDetails))]
[JsonSerializable(typeof(HttpValidationProblemDetails))]
[JsonSerializable(typeof(string))]
internal sealed partial class NixJsonSerializerContext : JsonSerializerContext;
