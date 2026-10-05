using System.Net;
using System.Text;
using Nix.Abstractions;
using Nix.Authentication;

namespace Nix.Tests.Authentication;

public sealed class UserInfoClientTests
{
    [Fact]
    public async Task Exact_subject_and_typed_claims_produce_a_bounded_profile()
    {
        using var handler = new ResponseHandler(static request =>
        {
            Assert.Equal("Bearer access-token", request.Headers.Authorization?.ToString());
            return Json("""
                {"sub":"subject-1","name":"  Ada Lovelace  ","email":" Ada@Example.Test ","email_verified":true}
                """);
        });
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var profile = await reader.ReadAsync(
            new Uri("https://issuer.example.test/oidc/v1/userinfo"),
            "https://issuer.example.test/oidc",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken);

        Assert.Equal("Ada Lovelace", profile.DisplayName);
        Assert.Equal("Ada@Example.Test", profile.Email);
        Assert.True(profile.EmailVerified);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("{\"sub\":17}")]
    [InlineData("{\"sub\":\"subject-1\",\"sub\":\"subject-1\"}")]
    [InlineData("{\"sub\":\"subject-1\",\"email_verified\":\"true\"}")]
    [InlineData("{\"sub\":\"subject-1\",\"name\":{}}")]
    [InlineData("{\"sub\":\"subject-1\",\"unknown\":[[[[[[[[[]]]]]]]]]}")]
    [InlineData("{\"sub\":\"subject-1\"} trailing")]
    public async Task Malformed_duplicate_deep_or_wrongly_typed_claims_fail_closed(string payload)
    {
        using var handler = new ResponseHandler(_ => Json(payload));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoMalformed, exception.Category);
    }

    [Fact]
    public async Task A_different_subject_fails_closed()
    {
        using var handler = new ResponseHandler(_ => Json("{\"sub\":\"somebody-else\"}"));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoMalformed, exception.Category);
    }

    [Fact]
    public async Task A_present_verified_email_over_the_normalized_schema_bound_fails_closed()
    {
        var email = new string('a', 310) + "@example.test";
        using var handler = new ResponseHandler(_ => Json(
            $"{{\"sub\":\"subject-1\",\"email\":\"{email}\",\"email_verified\":true}}"));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoMalformed, exception.Category);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Redirect)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task Every_non_success_provider_status_fails_retryably(HttpStatusCode status)
    {
        using var handler = new ResponseHandler(_ => new HttpResponseMessage(status));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoStatus, exception.Category);
    }

    [Fact]
    public async Task Declared_or_streamed_responses_over_the_cap_fail_before_parsing()
    {
        var oversized = new string('x', (32 * 1024) + 1);
        using var declaredHandler = new ResponseHandler(_ => Json(oversized));
        using var declaredClient = new HttpClient(declaredHandler);
        var declaredReader = new UserInfoClient(declaredClient);

        await Assert.ThrowsAsync<UserInfoUnavailableException>(() => declaredReader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());

        using var streamedHandler = new ResponseHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new UnknownLengthContent(oversized),
        });
        using var streamedClient = new HttpClient(streamedHandler);
        var streamedReader = new UserInfoClient(streamedClient);

        await Assert.ThrowsAsync<UserInfoUnavailableException>(() => streamedReader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
    }

    [Theory]
    [InlineData("http://issuer.example.test/userinfo")]
    [InlineData("/userinfo")]
    public async Task Non_https_or_relative_endpoints_never_receive_the_bearer_token(string endpoint)
    {
        var called = false;
        using var handler = new ResponseHandler(_ =>
        {
            called = true;
            return Json("{\"sub\":\"subject-1\"}");
        });
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri(endpoint, UriKind.RelativeOrAbsolute),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.Endpoint, exception.Category);
        Assert.False(called);
    }

    [Fact]
    public async Task Same_origin_loopback_http_is_allowed_for_local_development()
    {
        using var handler = new ResponseHandler(_ => Json("{\"sub\":\"subject-1\"}"));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var profile = await reader.ReadAsync(
            new Uri("http://localhost:8300/oidc/v1/userinfo"),
            "http://localhost:8300",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken);

        Assert.Null(profile.DisplayName);
    }

    [Fact]
    public async Task Non_loopback_http_is_refused_even_when_the_origin_matches()
    {
        var called = false;
        using var handler = new ResponseHandler(_ =>
        {
            called = true;
            return Json("{\"sub\":\"subject-1\"}");
        });
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("http://issuer.example.test/userinfo"),
            "http://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(ProvisioningFailureCategory.Endpoint, exception.Category);
        Assert.False(called);
    }

    [Theory]
    [InlineData("https://other.example.test/userinfo", "https://issuer.example.test")]
    [InlineData("https://user:password@issuer.example.test/userinfo", "https://issuer.example.test")]
    [InlineData("https://issuer.example.test/userinfo#fragment", "https://issuer.example.test")]
    [InlineData("https://issuer.example.test:444/userinfo", "https://issuer.example.test")]
    public async Task Cross_origin_credentials_fragments_and_effective_port_changes_are_refused_before_send(
        string endpoint,
        string issuer)
    {
        var called = false;
        using var handler = new ResponseHandler(_ =>
        {
            called = true;
            return Json("{\"sub\":\"subject-1\"}");
        });
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri(endpoint),
            issuer,
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.False(called);
    }

    [Theory]
    [InlineData("https://issuer.example.test/userinfo", "https://issuer.example.test:443/oidc")]
    [InlineData("https://issuer.example.test:443/userinfo", "https://issuer.example.test/oidc")]
    [InlineData("https://ISSUER.example.test/userinfo", "https://issuer.EXAMPLE.test/oidc")]
    public async Task Default_ports_host_case_and_issuer_paths_normalize_to_the_same_origin(
        string endpoint,
        string issuer)
    {
        using var handler = new ResponseHandler(_ => Json("{\"sub\":\"subject-1\"}"));
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var profile = await reader.ReadAsync(
            new Uri(endpoint),
            issuer,
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken);

        Assert.Null(profile.DisplayName);
    }

    [Fact]
    public async Task The_five_second_policy_covers_slow_headers_and_the_complete_body_read()
    {
        using var headerHandler = new DelayedHeaderHandler(TimeSpan.FromSeconds(1));
        using var headerClient = new HttpClient(headerHandler) { Timeout = Timeout.InfiniteTimeSpan };
        var headerReader = new UserInfoClient(headerClient, TimeSpan.FromMilliseconds(25));
        var headerException = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => headerReader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoTimeout, headerException.Category);

        using var bodyHandler = new ResponseHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new DelayedBodyContent(TimeSpan.FromSeconds(1)),
        });
        using var bodyClient = new HttpClient(bodyHandler) { Timeout = Timeout.InfiniteTimeSpan };
        var bodyReader = new UserInfoClient(bodyClient, TimeSpan.FromMilliseconds(25));
        var bodyException = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => bodyReader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoTimeout, bodyException.Category);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Stream_open_and_read_io_failures_become_retryable_unavailability(bool failOnOpen)
    {
        using var handler = new ResponseHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new FailingContent(failOnOpen),
        });
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        var exception = await Assert.ThrowsAsync<UserInfoUnavailableException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(ProvisioningFailureCategory.UserInfoTransport, exception.Category);
    }

    [Fact]
    public async Task Caller_cancellation_is_preserved_instead_of_becoming_provider_unavailability()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        using var handler = new CancellingHandler();
        using var client = new HttpClient(handler);
        var reader = new UserInfoClient(client);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(
            new Uri("https://issuer.example.test/userinfo"),
            "https://issuer.example.test",
            "access-token",
            "subject-1",
            cancellation.Token).AsTask());
    }

    private static HttpResponseMessage Json(string payload) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(payload, Encoding.UTF8, "application/json"),
    };

    private sealed class ResponseHandler(Func<HttpRequestMessage, HttpResponseMessage> respond)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }

    private sealed class CancellingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromCanceled<HttpResponseMessage>(cancellationToken);
    }

    private sealed class DelayedHeaderHandler(TimeSpan delay) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(delay, cancellationToken);
            return Json("{\"sub\":\"subject-1\"}");
        }
    }

    private sealed class DelayedBodyContent(TimeSpan delay) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            throw new NotSupportedException();

        protected override Task<Stream> CreateContentReadStreamAsync() =>
            Task.FromResult<Stream>(new DelayedReadStream(delay));

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    private sealed class FailingContent(bool failOnOpen) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            throw new NotSupportedException();

        [System.Diagnostics.CodeAnalysis.SuppressMessage(
            "Reliability",
            "CA2000:Dispose objects before losing scope",
            Justification = "HttpContent transfers the returned stream to HttpClient, which disposes it with the response.")]
        protected override Task<Stream> CreateContentReadStreamAsync() => failOnOpen
            ? Task.FromException<Stream>(new IOException("stream open failed"))
            : Task.FromResult<Stream>(new FailingReadStream());

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    private class DelayedReadStream(TimeSpan delay) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            await Task.Delay(delay, cancellationToken);
            return 0;
        }
    }

    private sealed class FailingReadStream : DelayedReadStream
    {
        public FailingReadStream()
            : base(TimeSpan.Zero)
        {
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default) =>
            ValueTask.FromException<int>(new IOException("stream read failed"));
    }

    private sealed class UnknownLengthContent(string payload) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(Encoding.UTF8.GetBytes(payload)).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
