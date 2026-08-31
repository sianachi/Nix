using System.Text.Json.Serialization;
using Nix.Features.Internal;

namespace Nix.Serialization;

/// <summary>
/// The internal surface's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// The internal surface is absent from the OpenAPI document but not from the serializer - a
/// response type missing from a context fails loudly at runtime, and "internal" is not a reason
/// to find out on the first handshake.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ItemAuthorizationResponse))]
[JsonSerializable(typeof(CreateWorkerJobRequest))]
[JsonSerializable(typeof(WorkerOutboxRequest))]
[JsonSerializable(typeof(LeaseWorkerJobsRequest))]
[JsonSerializable(typeof(CompleteWorkerJobRequest))]
[JsonSerializable(typeof(WorkerJobResponse))]
[JsonSerializable(typeof(IReadOnlyList<WorkerJobResponse>))]
[JsonSerializable(typeof(LeaseWorkerOutboxRequest))]
[JsonSerializable(typeof(FailWorkerOutboxRequest))]
[JsonSerializable(typeof(WorkerOutboxEventResponse))]
[JsonSerializable(typeof(IReadOnlyList<WorkerOutboxEventResponse>))]
internal sealed partial class InternalJsonContext : JsonSerializerContext;
