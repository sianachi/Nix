using Nix.Domain.Primitives;

namespace Nix.Domain.Files;

public readonly record struct FileVersionId(Guid Value) : INixId<FileVersionId>
{
    public static FileVersionId From(Guid value) => new(value);
    public static FileVersionId Create() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString("D");
}

public readonly record struct FileUploadId(Guid Value) : INixId<FileUploadId>
{
    public static FileUploadId From(Guid value) => new(value);
    public static FileUploadId Create() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString("D");
}
