using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;

namespace Nix.Serialization;

/// <summary>
/// The API's only JSON contract source. Every type that crosses the HTTP boundary is declared
/// serializable so serialization is source-generated: no reflection, no runtime contract discovery
/// on a request path (engineering plan section 3.2).
/// </summary>
/// <remarks>
/// <para>
/// <c>Program</c> installs this as the sole <c>TypeInfoResolver</c> for HTTP JSON, replacing the
/// reflection-based default outright. That is deliberate: a DTO that someone forgets to register
/// fails loudly the first time it is serialized rather than silently falling back to reflection.
/// </para>
/// <para>
/// <b>The type declarations live with their features, not here.</b> This file holds the generation
/// options and the framework types that belong to no feature; each feature folder carries its own
/// <c>&lt;Feature&gt;JsonContext.cs</c>. Attributes on partial declarations of one class are
/// merged by the compiler, so the generated context is identical either way - what changes is that
/// adding a response type touches one file inside one feature instead of a file every feature
/// shares. With several goals in flight at once a single registration point is a merge conflict on
/// every one of them, and they are the boring kind that get resolved carelessly.
/// </para>
/// <para>
/// <c>string</c> is registered because <c>ProblemDetails.Extensions</c> is an
/// <c>IDictionary&lt;string, object?&gt;</c> whose values are serialized by their runtime type; the
/// <c>code</c> and <c>traceId</c> extensions are strings.
/// </para>
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
[JsonSerializable(typeof(HttpValidationProblemDetails))]
[JsonSerializable(typeof(string))]
internal sealed partial class NixJsonSerializerContext : JsonSerializerContext;
