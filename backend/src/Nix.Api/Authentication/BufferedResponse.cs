namespace Nix.Authentication;

internal static class BufferedResponse
{
    internal static FileStream Create()
    {
        var options = new FileStreamOptions
        {
            Access = FileAccess.ReadWrite,
            BufferSize = 64 * 1024,
            Mode = FileMode.CreateNew,
            Options = FileOptions.Asynchronous | FileOptions.DeleteOnClose | FileOptions.SequentialScan,
            Share = FileShare.None,
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        return new FileStream(
            Path.Combine(Path.GetTempPath(), $"nix-response-{Guid.NewGuid():N}.tmp"),
            options);
    }

    internal static async Task PublishAsync(
        HttpContext context,
        FileStream bufferedBody,
        Stream originalBody)
    {
        context.Response.Body = originalBody;
        bufferedBody.Position = 0;
        if (context.Response.StatusCode is not (StatusCodes.Status204NoContent or StatusCodes.Status304NotModified))
        {
            context.Response.ContentLength = bufferedBody.Length;
        }
        await bufferedBody.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
    }
}
