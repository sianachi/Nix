using System.Text;
using Microsoft.AspNetCore.DataProtection;

namespace Nix.Features.Pets;

/// <summary>Protects a person's provider API key at rest with the host's Data Protection key ring.</summary>
public sealed class PetProviderKeyProtector
{
    /// <summary>The purpose string; changing it would make every stored key unreadable.</summary>
    public const string Purpose = "Nix.Pets.ProviderKey.v1";

    private readonly IDataProtector _protector;

    /// <summary>Creates the protector.</summary>
    /// <param name="provider">The host's Data Protection provider.</param>
    public PetProviderKeyProtector(IDataProtectionProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        _protector = provider.CreateProtector(Purpose);
    }

    /// <summary>Protects a key for storage.</summary>
    public byte[] Protect(string key) => _protector.Protect(Encoding.UTF8.GetBytes(key));

    /// <summary>Recovers a stored key; throws when the payload was not protected by this ring.</summary>
    public string Unprotect(ReadOnlyMemory<byte> payload) => Encoding.UTF8.GetString(_protector.Unprotect(payload.ToArray()));
}
