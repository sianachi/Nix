using System.Net;
using System.Security.Cryptography;
using System.Text;
using Nix.Persistence.ObjectStorage;
using Xunit.Sdk;

namespace Nix.Integration.Tests.Persistence.ObjectStorage;

public sealed class VersityImmutableUploadTests
{
    [Fact]
    public async Task PutImmutableVerified_rejects_replacement_and_bad_body_checksum_on_local_Versity()
    {
        if (Environment.GetEnvironmentVariable("NIX_TEST_VERSITY_UPLOAD_PROOFS") != "1")
        {
            throw SkipException.ForSkip("Set NIX_TEST_VERSITY_UPLOAD_PROOFS=1 to run against local Versity.");
        }

        var signer = new S3CapabilitySigner(new ObjectStorageOptions
        {
            Endpoint = new Uri(Environment.GetEnvironmentVariable("NIX_VERSITY_ENDPOINT") ?? "http://localhost:7070"),
            Region = Environment.GetEnvironmentVariable("NIX_VERSITY_REGION") ?? "us-east-1",
            Bucket = Environment.GetEnvironmentVariable("NIX_VERSITY_BUCKET") ?? "nix-worker-jobs",
            AccessKey = Environment.GetEnvironmentVariable("NIX_VERSITY_ACCESS_KEY") ?? "nix-dev-access",
            SecretKey = Environment.GetEnvironmentVariable("NIX_VERSITY_SECRET_KEY") ?? "nix-dev-secret-key",
            CapabilitySeconds = 300,
        }, TimeProvider.System);
        using var client = new HttpClient();
        var expected = Encoding.UTF8.GetBytes("template file transfer checksum proof");
        var wrong = Encoding.UTF8.GetBytes("template file transfer checksum spoof");
        var cancellationToken = TestContext.Current.CancellationToken;
        var digest = Convert.ToHexStringLower(SHA256.HashData(expected));
        var replacementKey = $"template-foundations/immutable/{Guid.NewGuid():N}";
        var checksumKey = $"template-foundations/checksum/{Guid.NewGuid():N}";

        using var first = await PutAsync(signer, client, replacementKey, expected, digest, cancellationToken);
        Assert.True(first.IsSuccessStatusCode, $"Versity rejected the initial immutable PUT with {(int)first.StatusCode}.");
        using var replacement = await PutAsync(signer, client, replacementKey, expected, digest, cancellationToken);
        Assert.Equal(HttpStatusCode.PreconditionFailed, replacement.StatusCode);
        using var original = await client.GetAsync(signer.Get(replacementKey).Url, cancellationToken);
        Assert.Equal(expected, await original.Content.ReadAsByteArrayAsync(cancellationToken));

        using var badChecksum = await PutAsync(signer, client, checksumKey, wrong, digest, cancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, badChecksum.StatusCode);
        Assert.Contains("BadDigest", await badChecksum.Content.ReadAsStringAsync(cancellationToken), StringComparison.Ordinal);
        using var missing = await client.GetAsync(signer.Get(checksumKey).Url, cancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

        await DeleteAsync(signer, client, replacementKey, cancellationToken);
        await DeleteAsync(signer, client, checksumKey, cancellationToken);
    }

    private static async Task<HttpResponseMessage> PutAsync(
        S3CapabilitySigner signer,
        HttpClient client,
        string key,
        byte[] body,
        string declaredSha256,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, signer.PutImmutableVerified(
            key,
            body.Length,
            declaredSha256).Url)
        {
            Content = new ByteArrayContent(body),
        };
        request.Headers.TryAddWithoutValidation("If-None-Match", "*");
        request.Headers.TryAddWithoutValidation(
            "x-amz-checksum-sha256",
            Convert.ToBase64String(Convert.FromHexString(declaredSha256)));
        request.Content.Headers.ContentLength = body.Length;
        return await client.SendAsync(request, cancellationToken);
    }

    private static async Task DeleteAsync(
        S3CapabilitySigner signer,
        HttpClient client,
        string key,
        CancellationToken cancellationToken)
    {
        using var response = await client.DeleteAsync(signer.Delete(key).Url, cancellationToken);
        Assert.True(response.StatusCode is HttpStatusCode.NoContent or HttpStatusCode.NotFound or HttpStatusCode.OK);
    }
}
