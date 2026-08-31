using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nix.Persistence.RabbitMq;

/// <summary>Bounded, versioned envelope published from the durable Postgres outbox.</summary>
public sealed record RabbitMessageEnvelope(
    int SchemaVersion,
    Guid MessageId,
    string MessageType,
    DateTimeOffset OccurredAt,
    Guid TenantId,
    Guid? WorkspaceId,
    Guid? ItemId,
    string Kind,
    JsonElement Payload,
    string CorrelationId,
    string? CausationId = null,
    string? TraceParent = null);

/// <summary>Terminal or retryable execution result emitted by a Go worker.</summary>
public sealed record WorkerResultEnvelope(
    int SchemaVersion,
    Guid MessageId,
    string MessageType,
    DateTimeOffset OccurredAt,
    Guid JobId,
    string ExecutionId,
    bool Succeeded,
    bool Retryable,
    JsonElement? Result = null,
    string? ErrorCode = null,
    string? ErrorDetail = null,
    string? TraceParent = null);

/// <summary>Source-generated internal broker JSON.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(RabbitMessageEnvelope))]
[JsonSerializable(typeof(WorkerResultEnvelope))]
internal sealed partial class RabbitMqJsonContext : JsonSerializerContext;
