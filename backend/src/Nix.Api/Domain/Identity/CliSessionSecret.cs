using System.Buffers.Text;
using System.Security.Cryptography;

namespace Nix.Domain.Identity;

/// <summary>Distinct credentials for browser-approved CLI sessions and pending login challenges.</summary>
public static class CliSessionSecret
{
    /// <summary>The CLI refresh credential prefix. Browser cookies never accept this credential.</summary>
    public const string Prefix = "nixcli_";

    /// <summary>The secret challenge held only by the requesting CLI.</summary>
    public const string DevicePrefix = "nixclidevice_";

    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    /// <summary>Mints a random 256-bit CLI refresh credential, persisting only its hash.</summary>
    public static MintedBrowserSessionSecret Mint() => MintWithPrefix(Prefix);

    /// <summary>Mints a random 256-bit device challenge, persisting only its hash.</summary>
    public static MintedBrowserSessionSecret MintDevice() => MintWithPrefix(DevicePrefix);

    /// <summary>Mints a 50-bit human-readable challenge; Core stores only its hash.</summary>
    public static string MintUserCode()
    {
        var characters = new char[10];
        for (var index = 0; index < characters.Length; index++)
        {
            characters[index] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        }

        return new string(characters, 0, 5) + "-" + new string(characters, 5, 5);
    }

    /// <summary>Accepts the exact displayed code with an optional separator and casing.</summary>
    public static string? NormalizeUserCode(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 11)
        {
            return null;
        }

        var code = value.Replace("-", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        return code.Length == 10 && code.All(character => Alphabet.Contains(character, StringComparison.Ordinal))
            ? code
            : null;
    }

    private static MintedBrowserSessionSecret MintWithPrefix(string prefix)
    {
        var token = prefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        return new MintedBrowserSessionSecret(token, BrowserSessionSecret.Hash(token));
    }
}
