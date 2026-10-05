using System.Buffers;

namespace Nix.Authentication;

/// <summary>Streams an HTTP body into a small, enforced contiguous bound.</summary>
internal static class BoundedHttpContent
{
    /// <summary>Reads at most <paramref name="maximumBytes"/> or throws.</summary>
    internal static async ValueTask<byte[]> ReadAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumBytes);
        if (content.Headers.ContentLength is > 0 and var declared && declared > maximumBytes)
        {
            throw new InvalidDataException("The upstream response exceeded its configured bound.");
        }

        var initialCapacity = content.Headers.ContentLength is > 0 and var length
            ? (int)Math.Min(length, maximumBytes)
            : 0;
        using var output = new MemoryStream(initialCapacity);
        var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var buffer = ArrayPool<byte>.Shared.Rent(8192);
            try
            {
                while (true)
                {
                    var read = await stream
                        .ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maximumBytes + 1)), cancellationToken)
                        .ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    if (output.Length + read > maximumBytes)
                    {
                        throw new InvalidDataException("The upstream response exceeded its configured bound.");
                    }

                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        // byte[]: JsonDocument requires contiguous UTF-8 input; this allocation is capped at 32 KiB.
        return output.ToArray();
    }
}
