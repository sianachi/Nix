using System.Net.Http.Json;
using System.Text.Json;
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
    INixSessionContextAccessor session, NixDispatcher dispatcher, IPermissionResolver permissions)
{
    /// <summary>Validates the caller's scope before forwarding a bounded companion operation.</summary>
    public async Task<Result<PetConnectionResponse>> ExecuteAsync(PetRuntimeRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        if (request.Operation is not ("status" or "connect" or "disconnect" or "models" or "read" or "send" or "interrupt" or "reset" or "tool_claim" or "tool_result" or "history" or "read_history" or "delete_history")
            || request.Text is null || request.SharedText is null || request.Text.Length > 8000 || request.SharedText.Length > 16000
            || request.Model is null || request.Model.Length > 160 || request.ToolId is null || request.ToolId.Length > 200
            || request.ToolResult is null || request.ToolResult.Length > 32000
            || request.Operation is "tool_claim" or "tool_result" && (request.RequestId is null || request.RequestId == Guid.Empty || request.ToolId.Length == 0))
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
            request.Model, request.WorkspaceAccess, request.ToolId, request.ToolResult, request.ToolSuccess, request.HistoryId?.ToString() ?? ""), PetJsonContext.Default.PetWorkerRequest);
        try
        {
            using var response = await http.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion could not complete this request. Retry or reconnect ChatGPT."));
            }

            // A conversation is bounded to forty messages; never consume an unbounded provider body.
            await response.Content.LoadIntoBufferAsync(4 * 1024 * 1024, timeout.Token).ConfigureAwait(false);
            var value = await response.Content.ReadFromJsonAsync(PetJsonContext.Default.PetConnectionResponse, timeout.Token).ConfigureAwait(false);
            return value is null ? Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion returned an empty response.")) : Result.Success(value);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return Result.Failure<PetConnectionResponse>(new("pets.unavailable", "The companion is unreachable. Check the existing worker and try again."));
        }
    }
}
