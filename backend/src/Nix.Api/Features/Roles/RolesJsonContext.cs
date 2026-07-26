using System.Text.Json.Serialization;
using Nix.Api.Contracts;
using Nix.Api.Features.Roles;

namespace Nix.Api.Serialization;

/// <summary>
/// The roles feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature rather than one for the API, and <c>Program</c> chains them all onto
/// the serializer's resolver chain. The generated output is equivalent either way; what changes is
/// that adding a response type touches a file inside one feature instead of a file every feature
/// shares. With several goals in flight at once, a single registration point is a merge conflict
/// on every one of them - and they are the boring kind that get resolved carelessly.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(RoleGrantResponse))]
[JsonSerializable(typeof(CursorPage<RoleGrantResponse>))]
internal sealed partial class RolesJsonContext : JsonSerializerContext;
