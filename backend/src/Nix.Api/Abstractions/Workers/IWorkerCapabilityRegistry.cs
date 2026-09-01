namespace Nix.Abstractions.Workers;

/// <summary>Live worker capabilities learned from bounded RabbitMQ advertisements.</summary>
/// <remarks>
/// The in-memory implementation is deliberately rebuildable: workers refresh their advertisement
/// before it expires. A durable registry can replace it if capability history ever becomes product
/// data; tests provide a fake at the feature boundary.
/// </remarks>
public interface IWorkerCapabilityRegistry
{
    public void Replace(WorkerCapabilityAdvertisement advertisement);

    public IReadOnlyList<ExportFormatCapability> ExportFormats(DateTimeOffset now);
}

public sealed record ExportFormatCapability(
    string Format,
    string Label,
    string Extension,
    string MediaType,
    bool Lossless,
    IReadOnlyList<string> DeclaredLoss);

public sealed record WorkerCapabilityAdvertisement(
    string InstanceId,
    string Role,
    DateTimeOffset OccurredAt,
    DateTimeOffset ExpiresAt,
    IReadOnlyList<ExportFormatCapability> ExportFormats);
