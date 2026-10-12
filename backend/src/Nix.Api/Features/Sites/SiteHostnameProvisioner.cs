using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Sites;

namespace Nix.Features.Sites;

/// <summary>The Cloudflare records Nix created for one hostname, so removal deletes exactly those.</summary>
/// <param name="ZoneId">The zone the records are in.</param>
/// <param name="Records">The ids of the records Nix created.</param>
/// <param name="Tunnel">Whether Nix added the tunnel's public hostname rule.</param>
public sealed record SiteManagedRecords(string ZoneId, IReadOnlyList<string> Records, bool Tunnel);

/// <summary>What one provisioning run did.</summary>
/// <param name="Error">A short error code, or null when every record is in place.</param>
/// <param name="Changed">Whether anything was created or changed in Cloudflare (audited).</param>
public sealed record SiteProvisioning(string? Error, bool Changed);

/// <summary>
/// Creates and removes the DNS records (and tunnel public hostname) of a custom hostname in a zone
/// the operator handed to the site's workspace, and of a default hostname on an instance whose
/// default hostnames carry a label suffix (no wildcard covers them). Idempotent: a repeat finds its own tagged records
/// and corrects them in place. It never overwrites or deletes a record it did not create.
/// </summary>
public sealed class SiteHostnameProvisioner(ICloudflareDns cloudflare, ISiteTunnelLock tunnelLock, SiteOptions options)
{
    /// <summary>Whether Nix manages DNS for <paramref name="hostname"/> of a site in <paramref name="workspaceId"/>.</summary>
    public bool Manages(string hostname, Guid workspaceId) => options.Cloudflare.ZoneFor(hostname, workspaceId) is not null;

    /// <summary>The routing target a managed hostname's CNAME points at.</summary>
    public string? RoutingTarget => RoutingTargetFor(options, managed: true);

    /// <summary>
    /// The CNAME target of a custom hostname: through the tunnel or the operator's default target
    /// when Nix manages the zone, else the deployment's published target (null when none is set).
    /// </summary>
    public static string? RoutingTargetFor(SiteOptions options, bool managed)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (managed && options.Cloudflare.TunnelId is { Length: > 0 } tunnel)
        {
            return tunnel + ".cfargotunnel.com";
        }

        return managed && options.Cloudflare.DefaultTarget is { Length: > 0 } target ? target : options.CustomHostnameTarget;
    }

    /// <summary>
    /// Ensures the verification TXT, the proxied CNAME and (with a tunnel) the public hostname rule,
    /// and records in <see cref="SiteHostname.ManagedRecords"/> what Nix owns. All or nothing: when a
    /// step fails, whatever this call created is deleted again and the error code is returned.
    /// </summary>
    /// <returns>The outcome: an error code or null, and whether anything was written to Cloudflare.</returns>
    public async Task<SiteProvisioning> ProvisionAsync(Site site, SiteHostname hostname, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(hostname);
        // A default hostname goes only to the configured zone of the sites domain and needs no
        // verification record; a custom one only to a zone handed to the site's workspace.
        var isDefault = hostname.Kind == SiteRules.DefaultHost;
        var zone = isDefault ? null : options.Cloudflare.ZoneFor(hostname.Hostname, site.WorkspaceId.Value);
        if (isDefault ? !options.AutomatesDefaultHostname(hostname.Hostname) : zone is null || hostname.VerificationToken is null)
        {
            return new SiteProvisioning(null, false);
        }

        var owned = Read(hostname.ManagedRecords);
        var created = new List<string>();
        var adopted = new List<string>();
        var addedRule = false;
        var changed = false;
        string? zoneId = isDefault ? options.Cloudflare.DefaultHostnameZoneId : owned?.ZoneId;
        try
        {
            zoneId ??= await cloudflare.FindZoneIdAsync(zone!.Zone, cancellationToken).ConfigureAwait(false);
            if (zoneId is null)
            {
                return new SiteProvisioning("cloudflare_zone_missing", false);
            }

            var tag = Tag(site.Id);
            if (!isDefault)
            {
                var token = hostname.VerificationToken!;
                var txt = await EnsureAsync(
                    zoneId,
                    new CloudflareDnsRecordInput("TXT", SiteHostnameRules.VerificationName(hostname.Hostname), SiteHostnameRules.VerificationValue(token), false, tag),
                    matchesForeign: record => record.Type == "TXT" && Unquote(record.Content) == SiteHostnameRules.VerificationValue(token),
                    blockingNames: [],
                    cancellationToken).ConfigureAwait(false);
                Collect(txt);
            }

            if (RoutingTarget is { } target)
            {
                var cname = await EnsureAsync(
                    zoneId,
                    new CloudflareDnsRecordInput("CNAME", hostname.Hostname, target, true, tag),
                    matchesForeign: record => record.Type == "CNAME" && record.Content == target,
                    // The other instance's wildcard is expected on the shared zone; the exact
                    // record overrides it for this name only.
                    blockingNames: isDefault ? [] : CoveringWildcards(hostname.Hostname, zone!.Zone),
                    cancellationToken).ConfigureAwait(false);
                if (cname.Blocked)
                {
                    await UndoAsync(zoneId, created, addedRule, hostname.Hostname, cancellationToken).ConfigureAwait(false);
                    return new SiteProvisioning("routing_record_foreign", changed);
                }

                Collect(cname);
            }

            if (options.Cloudflare.TunnelId is { Length: > 0 })
            {
                addedRule = await EnsureTunnelRuleAsync(hostname.Hostname, cancellationToken).ConfigureAwait(false);
                changed |= addedRule;
            }

            var records = (owned?.Records ?? []).Concat(adopted).Concat(created).Distinct(StringComparer.Ordinal).ToArray();
            hostname.ManagedRecords = records.Length > 0 || addedRule || owned?.Tunnel == true
                ? Write(new SiteManagedRecords(zoneId, records, addedRule || owned?.Tunnel == true))
                : null;
            return new SiteProvisioning(null, changed);
        }
        catch (CloudflareApiException exception)
        {
            if (zoneId is not null)
            {
                await UndoAsync(zoneId, created, addedRule, hostname.Hostname, cancellationToken).ConfigureAwait(false);
            }

            return new SiteProvisioning(Clip(exception.Message), changed);
        }

        void Collect(Ensured ensured)
        {
            changed |= ensured.Wrote;
            if (ensured.OwnedId is { } id)
            {
                (ensured.Created ? created : adopted).Add(id);
            }
        }
    }

    /// <summary>
    /// Ensures the record (and tunnel rule) of a default hostname on an instance that automates
    /// them, and writes the outcome onto the row: what Nix owns, and the error or none. A no-op for
    /// every other name.
    /// </summary>
    /// <returns>The outcome, for the caller to audit when anything changed or failed.</returns>
    public async Task<SiteProvisioning> EnsureDefaultAsync(Site site, SiteHostname hostname, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        if (hostname.Kind != SiteRules.DefaultHost || !options.AutomatesDefaultHostname(hostname.Hostname))
        {
            return new SiteProvisioning(null, false);
        }

        var outcome = await ProvisionAsync(site, hostname, cancellationToken).ConfigureAwait(false);
        hostname.CheckError = outcome.Error;
        return outcome;
    }

    /// <summary>
    /// Takes the tunnel lock up front when a tunnel is configured. A caller that will take a site
    /// lock and then remove hostnames calls this first, so every path locks the tunnel before a site.
    /// </summary>
    public async ValueTask LockTunnelAsync(CancellationToken cancellationToken)
    {
        if (options.Cloudflare.TunnelId is { Length: > 0 })
        {
            await tunnelLock.LockAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Deletes the records and tunnel rule Nix created for the hostname. Returns an error code, or
    /// null. Records Nix still owns but can no longer reach (automation switched off, the API
    /// refusing) are kept on the hostname and reported, never forgotten.
    /// </summary>
    public async Task<string?> RemoveAsync(SiteHostname hostname, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        if (Read(hostname.ManagedRecords) is not { } owned)
        {
            return null;
        }

        if (!options.Cloudflare.IsEnabled)
        {
            return "cloudflare_not_configured";
        }

        try
        {
            if (owned.ZoneId.Length > 0)
            {
                foreach (var record in owned.Records)
                {
                    await cloudflare.DeleteRecordAsync(owned.ZoneId, record, cancellationToken).ConfigureAwait(false);
                }
            }

            if (owned.Tunnel && options.Cloudflare.TunnelId is { Length: > 0 })
            {
                await RemoveTunnelRuleAsync(hostname.Hostname, cancellationToken).ConfigureAwait(false);
            }

            hostname.ManagedRecords = null;
            return null;
        }
        catch (CloudflareApiException exception)
        {
            return Clip(exception.Message);
        }
    }

    /// <summary>Reads stored managed records.</summary>
    public static SiteManagedRecords? Read(string? json) =>
        json is null ? null : JsonSerializer.Deserialize(json, SitesJsonContext.Default.SiteManagedRecords);

    private static string Write(SiteManagedRecords records) =>
        JsonSerializer.Serialize(records, SitesJsonContext.Default.SiteManagedRecords);

    private static string Tag(Guid siteId) => "managed-by nix site " + siteId.ToString("D");

    private static string Clip(string code) => code.Length <= 64 ? code : code[..64];

    private static string Unquote(string content) => content.Length >= 2 && content[0] == '"' && content[^1] == '"' ? content[1..^1] : content;

    // One record of one name and purpose: ours (tagged) is corrected in place; an equivalent record
    // someone else made is left as it is and not owned; a conflicting foreign one, at the name or
    // at a wildcard that covers it, blocks creation.
    private async Task<Ensured> EnsureAsync(
        string zoneId,
        CloudflareDnsRecordInput wanted,
        Func<CloudflareDnsRecord, bool> matchesForeign,
        IReadOnlyList<string> blockingNames,
        CancellationToken cancellationToken)
    {
        var existing = await cloudflare.ListRecordsAsync(zoneId, wanted.Name, cancellationToken).ConfigureAwait(false);
        var ours = existing.FirstOrDefault(record => record.Comment == wanted.Comment && record.Type == wanted.Type);
        if (ours is not null)
        {
            if ((ours.Content != wanted.Content && Unquote(ours.Content) != wanted.Content) || ours.Proxied != wanted.Proxied)
            {
                await cloudflare.UpdateRecordAsync(zoneId, ours.Id, wanted, cancellationToken).ConfigureAwait(false);
                return new Ensured(ours.Id, Created: false, Wrote: true, Blocked: false);
            }

            return new Ensured(ours.Id, Created: false, Wrote: false, Blocked: false);
        }

        if (existing.Any(matchesForeign))
        {
            return new Ensured(null, Created: false, Wrote: false, Blocked: false);
        }

        var foreign = existing.Where(Routes).ToList();
        foreach (var name in blockingNames)
        {
            foreign.AddRange((await cloudflare.ListRecordsAsync(zoneId, name, cancellationToken).ConfigureAwait(false)).Where(Routes));
        }

        if (wanted.Type == "CNAME" && foreign.Count > 0)
        {
            return new Ensured(null, Created: false, Wrote: false, Blocked: true);
        }

        var made = await cloudflare.CreateRecordAsync(zoneId, wanted, cancellationToken).ConfigureAwait(false);
        return new Ensured(made.Id, Created: true, Wrote: true, Blocked: false);

        static bool Routes(CloudflareDnsRecord record) => record.Type is "A" or "AAAA" or "CNAME";
    }

    // Every wildcard that would answer for the hostname: *.<parent> for each parent up to the zone.
    private static string[] CoveringWildcards(string hostname, string zone)
    {
        var names = new List<string>();
        for (var parent = hostname[(hostname.IndexOf('.', StringComparison.Ordinal) + 1)..];
             parent == zone || parent.EndsWith("." + zone, StringComparison.Ordinal);
             parent = parent[(parent.IndexOf('.', StringComparison.Ordinal) + 1)..])
        {
            names.Add("*." + parent);
            if (parent == zone)
            {
                break;
            }
        }

        return [.. names];
    }

    // Deletes what one provisioning run created, best effort: the call already failed.
    private async Task UndoAsync(string zoneId, List<string> created, bool addedRule, string hostname, CancellationToken cancellationToken)
    {
        try
        {
            foreach (var id in created)
            {
                await cloudflare.DeleteRecordAsync(zoneId, id, cancellationToken).ConfigureAwait(false);
            }

            if (addedRule)
            {
                await RemoveTunnelRuleAsync(hostname, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (CloudflareApiException)
        {
            // shortcut: a record left behind here is still tagged with the site id; sweep tagged
            // records by hand if this ever fails, or add a reconciler.
        }
    }

    private async Task RemoveTunnelRuleAsync(string hostname, CancellationToken cancellationToken)
    {
        await tunnelLock.LockAsync(cancellationToken).ConfigureAwait(false);
        var config = await cloudflare.GetTunnelConfigAsync(cancellationToken).ConfigureAwait(false);
        var ingress = IngressOf(config);
        var mine = ingress.Where(rule => HasHostname(rule, hostname)).ToArray();
        if (mine.Length == 0)
        {
            return;
        }

        foreach (var rule in mine)
        {
            ingress.Remove(rule);
        }

        await cloudflare.PutTunnelConfigAsync(config, cancellationToken).ConfigureAwait(false);
    }

    // Adds "hostname -> sites serve" before the catch-all rule. True only when Nix added it now.
    private async Task<bool> EnsureTunnelRuleAsync(string hostname, CancellationToken cancellationToken)
    {
        await tunnelLock.LockAsync(cancellationToken).ConfigureAwait(false);
        var config = await cloudflare.GetTunnelConfigAsync(cancellationToken).ConfigureAwait(false);
        var ingress = IngressOf(config);
        var existing = ingress.FirstOrDefault(rule => HasHostname(rule, hostname));
        if (existing is not null)
        {
            // Ours from an earlier run, or the operator's own: either way not newly owned.
            return false;
        }

        var rule = new JsonObject { ["hostname"] = hostname, ["service"] = options.Cloudflare.TunnelService };
        var catchAll = ingress.Count > 0 && ingress[^1]?["hostname"] is null ? ingress.Count - 1 : ingress.Count;
        ingress.Insert(catchAll, rule);
        if (catchAll == ingress.Count - 1)
        {
            // A tunnel configuration must end with a rule that matches everything.
            ingress.Add(new JsonObject { ["service"] = "http_status:404" });
        }

        await cloudflare.PutTunnelConfigAsync(config, cancellationToken).ConfigureAwait(false);
        return true;
    }

    // A configuration without an ingress list is never rewritten: a PUT of a fresh list would
    // replace every rule the operator has.
    private static JsonArray IngressOf(JsonObject config) =>
        config["ingress"] as JsonArray ?? throw new CloudflareApiException("cloudflare_malformed");

    private static bool HasHostname(JsonNode? rule, string hostname) =>
        rule is JsonObject candidate
        && candidate["hostname"] is JsonValue value
        && value.TryGetValue<string>(out var name)
        && name == hostname;

    private readonly record struct Ensured(string? OwnedId, bool Created, bool Wrote, bool Blocked);
}
