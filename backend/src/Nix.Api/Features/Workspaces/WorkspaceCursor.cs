using System.Globalization;
using System.Text;
using Nix.Domain.Tenancy;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

internal readonly record struct WorkspaceCursor(DateTimeOffset CreatedAt, WorkspaceId Id)
{
    internal const int MaximumEncodedLength = 512;

    internal static bool TryDecode(string? value, out WorkspaceCursor? cursor)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            cursor = null;
            return true;
        }
        if (value.Length > MaximumEncodedLength)
        {
            cursor = null;
            return false;
        }
        try
        {
            var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            var separator = decoded.IndexOf(':', StringComparison.Ordinal);
            if (separator < 1
                || !long.TryParse(decoded.AsSpan(0, separator), CultureInfo.InvariantCulture, out var ticks)
                || !Guid.TryParse(decoded.AsSpan(separator + 1), out var id))
            {
                cursor = null;
                return false;
            }

            cursor = new WorkspaceCursor(new DateTimeOffset(ticks, TimeSpan.Zero), WorkspaceId.From(id));
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            cursor = null;
            return false;
        }
        catch (FormatException)
        {
            cursor = null;
            return false;
        }
    }

    internal static string Encode(WorkspaceSnapshot row) => Convert.ToBase64String(
        Encoding.UTF8.GetBytes($"{row.CreatedAt.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{row.Id}"));
}
