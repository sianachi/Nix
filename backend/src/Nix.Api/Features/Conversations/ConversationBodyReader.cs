using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Features.Exports;

namespace Nix.Features.Conversations;

/// <summary>A bounded prose body from collaboration's authoritative Yjs log.</summary>
public sealed record ConversationBody(string Text, bool Truncated, bool Unsupported);

/// <summary>Reads bodies only while Core still authorizes the persisted turn and its source.</summary>
public sealed class ConversationBodyReader(HttpClient http, IConfiguration configuration,
    INixSessionContextAccessor session)
{
    /// <summary>Collaboration rechecks the running turn through Core before reading any body.</summary>
    public async Task<Result<ConversationBody>> ReadAsync(Guid conversationId, Guid requestId,
        Guid workspaceId, Guid itemId, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret)
            || !ExportEndpoints.TryCollaborationBaseUri(configuration, out var origin))
        {
            return Failure("conversations.body_unavailable", "The note body service is not configured.");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(HttpMethod.Post,
            new Uri(origin, $"internal/conversations/{conversationId:D}/body"));
        request.Headers.Add("x-nix-internal-secret", secret);
        request.Content = JsonContent.Create(new
        {
            tenantId = context.TenantId.Value,
            principalId = context.PrincipalId.Value,
            requestId,
            workspaceId,
            itemId,
        });
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead,
                timeout.Token).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.Forbidden)
            {
                return Failure("conversations.body_locked", "Unlock the note body before reading it.");
            }
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return Failure("conversations.source_unavailable", "This source is no longer available to the running conversation.");
            }
            if (!response.IsSuccessStatusCode)
            {
                return Failure("conversations.body_unavailable", "The note body could not be read. Retry before drawing conclusions.");
            }

            // The server caps prose at 24,000 characters; limit the JSON envelope before parsing.
            await response.Content.LoadIntoBufferAsync(192_000, timeout.Token).ConfigureAwait(false);
            var body = await response.Content.ReadFromJsonAsync<ConversationBody>(timeout.Token).ConfigureAwait(false);
            if (body is null || body.Text is null || body.Text.Length > 24_000)
            {
                return Failure("conversations.body_unavailable", "The note body service returned an invalid response.");
            }
            return Result.Success(body);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Failure("conversations.body_unavailable", "The note body service timed out. Retry before drawing conclusions.");
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException)
        {
            return Failure("conversations.body_unavailable", "The note body could not be read. Retry before drawing conclusions.");
        }
    }

    private static Result<ConversationBody> Failure(string code, string message) =>
        Result.Failure<ConversationBody>(new NixError(code, message));
}
