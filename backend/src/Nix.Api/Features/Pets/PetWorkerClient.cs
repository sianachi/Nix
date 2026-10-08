using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Pets;

/// <summary>Core's bounded, authenticated gateway to the companion in the existing Go worker.</summary>
public sealed class PetWorkerClient(HttpClient http, IConfiguration configuration,
    INixSessionContextAccessor session, NixDispatcher dispatcher, IPermissionResolver permissions,
    ILogger<PetWorkerClient>? logger = null)
{
    private readonly ILogger log = logger ?? NullLogger<PetWorkerClient>.Instance;

    /// <summary>Validates the caller's scope before forwarding a bounded companion operation.
    /// POST /runtime never accepts "watch": only <see cref="ExecuteWatchAsync"/> reaches the
    /// worker with that operation, through the same permission and identity checks below.</summary>
    public Task<Result<PetConnectionResponse>> ExecuteAsync(PetRuntimeRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Operation == "watch")
        {
            return Task.FromResult(Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Use the watch endpoint for this operation.")));
        }

        return ExecuteCoreAsync(request, after: 0, cancellationToken);
    }

    /// <summary>The GET watch path: builds the same worker request <see cref="ExecuteAsync"/>'s
    /// "read" builds - same identity derivation, same workspace permission checks, same persona
    /// handling - with operation "watch" and the client's last known revision.</summary>
    public Task<Result<PetConnectionResponse>> ExecuteWatchAsync(Guid workspaceId, Guid petId, string mode, long after, CancellationToken cancellationToken) =>
        ExecuteCoreAsync(new PetRuntimeRequest("watch", workspaceId, petId, Mode: mode), after, cancellationToken);

    private async Task<Result<PetConnectionResponse>> ExecuteCoreAsync(PetRuntimeRequest request, long after, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        if (request.Operation is not ("status" or "connect" or "disconnect" or "models" or "read" or "watch" or "send" or "interrupt" or "reset" or "tool_claim" or "tool_result" or "history" or "read_history" or "delete_history")
            || request.Text is null || request.SharedText is null || request.Text.Length > 8000 || request.SharedText.Length > 16000
            || request.Model is null || request.Model.Length > 160 || request.ToolId is null || request.ToolId.Length > 200
            || request.ToolResult is null || request.ToolResult.Length > 32000
            || request.Operation is "tool_claim" or "tool_result" && (request.RequestId is null || request.RequestId == Guid.Empty || request.ToolId.Length == 0)
            || request.Mode is null || request.Mode is not ("" or "chat" or "consult")
            || !IsValidTurnContext(request))
        {
            return Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Check the message and try again."));
        }

        var instructions = string.Empty;
        var title = string.Empty;
        if (request.Operation is not ("status" or "connect" or "disconnect" or "models"))
        {
            if (request.WorkspaceId is null || request.WorkspaceId == Guid.Empty || request.PetId is null || request.PetId == Guid.Empty)
            {
                return Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Choose a workspace and a pet."));
            }

            var workspace = await dispatcher.QueryAsync<GetWorkspace, WorkspaceSnapshot?>(
                new(new WorkspaceId(request.WorkspaceId.Value)), cancellationToken).ConfigureAwait(false);
            if (workspace is null || workspace.LifecycleState != "active"
                || !await permissions.CanReadWorkspaceAsync(workspace.Id, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<PetConnectionResponse>(new("pets.not_found", "Workspace is unavailable."));
            }

            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
            var pet = settings.Settings.Profiles.FirstOrDefault(profile => profile.Id == request.PetId);
            if (pet is null || request.Operation == "send" && !settings.Settings.Enabled)
            {
                return Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Enable a saved pet before starting a conversation."));
            }

            instructions = $"Your name is {pet.Name}. Communication style: {pet.Personality}. Response length: {pet.ResponseLength}. User preferences: {pet.Instructions}";
            if (request.Operation == "send" && (request.RequestId is null || request.RequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.Text)))
            {
                return Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "A message and request identity are required."));
            }

            if (request.ItemId is not null)
            {
                var item = await dispatcher.QueryAsync<GetItem, Result<Item>>(new(new ItemId(request.ItemId.Value)), cancellationToken).ConfigureAwait(false);
                if (item.IsFailure || item.Value.WorkspaceId.Value != request.WorkspaceId)
                {
                    return Result.Failure<PetConnectionResponse>(new("pets.not_found", "The shared item is unavailable."));
                }

                title = ItemProperties.ReadTitle(item.Value.Properties);
            }
            else if (request.SharedText.Length > 0)
            {
                return Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Select the item whose text you want to share."));
            }
        }

        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(secret))
        {
            return Result.Success(new PetConnectionResponse("chatgpt", "unavailable", "The companion is not enabled on this server. Configure the existing Go worker's companion data directory and Core's worker URL.", false, Messages: []));
        }

        if (!Uri.TryCreate(address, UriKind.Absolute, out var origin) || origin.Scheme is not ("http" or "https")
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0 || origin.AbsolutePath != "/")
        {
            return Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion worker URL is invalid."));
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(28));
        using var outgoing = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/companion"));
        outgoing.Headers.Add("X-Nix-Internal-Secret", secret);
        outgoing.Content = JsonContent.Create(new PetWorkerRequest(context.TenantId.Value.ToString(), context.PrincipalId.Value.ToString(),
            request.WorkspaceId?.ToString() ?? "", request.PetId?.ToString() ?? "", request.Operation,
            request.RequestId?.ToString() ?? "", request.Text, instructions, request.ItemId?.ToString() ?? "", title, request.SharedText,
            request.Model, request.WorkspaceAccess, request.ToolId, request.ToolResult, request.ToolSuccess, request.HistoryId?.ToString() ?? "",
            request.Mode, after, request.Today, request.TimeZone, request.WorkspaceMap), PetJsonContext.Default.PetWorkerRequest);
        try
        {
            using var response = await http.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var code = response.StatusCode switch
                {
                    HttpStatusCode.TooManyRequests => "pets.too_many_watches",
                    HttpStatusCode.Conflict => "pets.busy",
                    _ => "pets.unavailable",
                };
                ApiLog.PetWorkerFailed(log, request.Operation, $"worker returned HTTP {(int)response.StatusCode}", code);
                // The worker signals backpressure and single-flight contention with these two
                // codes; every other non-success collapses to the generic unavailable code.
                return response.StatusCode switch
                {
                    HttpStatusCode.TooManyRequests => Result.Failure<PetConnectionResponse>(
                        new("pets.too_many_watches", "Too many active watches. Close another tab and try again.")),
                    HttpStatusCode.Conflict => Result.Failure<PetConnectionResponse>(
                        new("pets.busy", "The companion is already handling another request.")),
                    _ => Result.Failure<PetConnectionResponse>(
                        new("pets.unavailable", "The companion could not complete this request. Retry or reconnect ChatGPT.")),
                };
            }

            // A conversation is bounded to forty messages; never consume an unbounded provider
            // body. Deserialising straight from the response stream, capped, avoids buffering
            // the whole body in memory before parsing it.
            var body = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            var capped = new CappedStream(body, MaxResponseBytes);
            await using (capped.ConfigureAwait(false))
            {
                PetConnectionResponse? value;
                try
                {
                    value = await JsonSerializer.DeserializeAsync(capped, PetJsonContext.Default.PetConnectionResponse, timeout.Token).ConfigureAwait(false);
                }
                catch (StreamCapExceededException)
                {
                    ApiLog.PetWorkerFailed(log, request.Operation, "response exceeded the size cap", "pets.unavailable");
                    return Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion response exceeded the size limit."));
                }

                return value is null ? Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion returned an empty response.")) : Result.Success(value);
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            ApiLog.PetWorkerFailed(log, request.Operation, exception.GetType().Name, "pets.unavailable");
            return Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion is unreachable. Check the existing worker and try again."));
        }
    }

    /// <summary>The most containers a conversation's first message may describe.</summary>
    internal const int MaxWorkspaceMapEntries = 40;

    /// <summary>Bounds the date, zone and workspace map a request carries. The map is accepted on a
    /// send only: no other operation starts a turn, so on any other it would be dead weight.</summary>
    private static bool IsValidTurnContext(PetRuntimeRequest request)
    {
        if (request.Today is null || request.TimeZone is null)
        {
            return false;
        }

        if (request.Today.Length > 0 && !DateOnly.TryParseExact(request.Today, "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _))
        {
            return false;
        }

        if (request.TimeZone.Length > 64 || request.TimeZone.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '_' or '+' or '-' or '/')))
        {
            return false;
        }

        var map = request.WorkspaceMap;
        if (map is null)
        {
            return true;
        }

        return request.Operation == "send" && map.Count <= MaxWorkspaceMapEntries
            && map.All(entry => entry is not null && entry.Id != Guid.Empty
                && entry.Title is { Length: <= 240 } && entry.Type is { Length: <= 64 }
                && (entry.ViewKinds is null || entry.ViewKinds.Count <= 12 && entry.ViewKinds.All(kind => kind is { Length: <= 40 })));
    }

    /// <summary>Opens the worker's inline stream and hands back the response, headers read and body unread.</summary>
    /// <remarks>
    /// The caller owns the returned response: it copies the body as it arrives and disposes the
    /// response on every path, which is also what tells the worker to interrupt the model's turn.
    /// <paramref name="cancellationToken"/> bounds the whole exchange, headers and body, so it is
    /// the caller's token that carries the browser's disconnect and the overall deadline; a
    /// cancellation by it propagates as <see cref="OperationCanceledException"/>. A worker that
    /// answers anything but a 200 event stream is turned into a coded failure here and its
    /// plain-text body is neither read nor forwarded. Nothing the person wrote is logged.
    /// </remarks>
    internal async Task<Result<HttpResponseMessage>> OpenInlineAsync(PetInlineRequest request, Guid petId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(secret)
            || !Uri.TryCreate(address, UriKind.Absolute, out var origin) || origin.Scheme is not ("http" or "https")
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0 || origin.AbsolutePath != "/")
        {
            ApiLog.PetWorkerFailed(log, "inline", "the worker URL or internal secret is not configured", "pets.unavailable");
            return Result.Failure<HttpResponseMessage>(new("pets.unavailable", "The companion is not available on this server."));
        }

        using var outgoing = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/companion"));
        HttpResponseMessage? response = null;
        try
        {
            outgoing.Headers.Add("X-Nix-Internal-Secret", secret);
            outgoing.Content = JsonContent.Create(new PetInlineWorkerRequest(context.TenantId.Value.ToString(), context.PrincipalId.Value.ToString(),
                request.WorkspaceId.ToString(), petId.ToString(), "inline", request.RequestId.ToString(), request.Instruction ?? "",
                request.Selection ?? "", request.Context ?? "", request.Kind, request.Kind == "translate" ? request.Language ?? "" : "",
                request.Model ?? ""), PetJsonContext.Default.PetInlineWorkerRequest);
            response = await http.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.OK
                && string.Equals(response.Content.Headers.ContentType?.MediaType, "text/event-stream", StringComparison.OrdinalIgnoreCase))
            {
                var opened = response;
                response = null;
                return Result.Success(opened);
            }

            var failure = response.StatusCode switch
            {
                HttpStatusCode.UnprocessableEntity => new NixError("pets.invalid_request", "The companion refused this request. Check the text and try again."),
                HttpStatusCode.TooManyRequests => new NixError("pets.inline_busy", "Too many writing requests are open. Wait for one to finish."),
                _ => new NixError("pets.unavailable", "The companion could not complete this request. Retry or reconnect ChatGPT."),
            };
            ApiLog.PetWorkerFailed(log, "inline", $"worker returned HTTP {(int)response.StatusCode} {response.Content.Headers.ContentType?.MediaType}", failure.Code);
            return Result.Failure<HttpResponseMessage>(failure);
        }
        catch (HttpRequestException exception)
        {
            ApiLog.PetWorkerFailed(log, "inline", exception.GetType().Name, "pets.unavailable");
            return Result.Failure<HttpResponseMessage>(new("pets.unavailable", "The companion is unreachable. Check the existing worker and try again."));
        }
        finally
        {
            response?.Dispose();
        }
    }

    private const int MaxResponseBytes = 4 * 1024 * 1024;

    /// <summary>Thrown by <see cref="CappedStream"/> once more than its byte limit has been read.</summary>
    private sealed class StreamCapExceededException : Exception
    {
        public StreamCapExceededException() : base("The stream exceeded its byte cap.")
        {
        }

        public StreamCapExceededException(string message) : base(message)
        {
        }

        public StreamCapExceededException(string message, Exception innerException) : base(message, innerException)
        {
        }
    }

    /// <summary>Read-only wrapper that enforces a byte cap while streaming, so the worker's JSON
    /// response is never buffered whole before the cap can be checked.</summary>
    private sealed class CappedStream(Stream inner, int limit) : Stream
    {
        private long _read;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException("Async reads only.");

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            _read += read;
            if (_read > limit)
            {
                throw new StreamCapExceededException();
            }

            return read;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
            }

            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await inner.DisposeAsync().ConfigureAwait(false);
            await base.DisposeAsync().ConfigureAwait(false);
        }
    }
}
