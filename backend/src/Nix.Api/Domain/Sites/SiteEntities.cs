using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Sites;

/// <summary>
/// A static publication of one item subtree (ADR-0063). The record is configuration only: what a
/// visitor sees is the live <see cref="SiteBuild"/> it points at.
/// </summary>
public sealed class Site
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the site's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the workspace the root item lives in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the item whose subtree the site publishes. One site per root.</summary>
    public required ItemId RootItemId { get; init; }

    /// <summary>Gets the globally unique label of the default hostname.</summary>
    public required string Slug { get; init; }

    /// <summary>Gets the theme layout: <c>docs</c> or <c>blog</c>.</summary>
    public string Layout { get; set; } = SiteRules.DocsLayout;

    /// <summary>Gets or sets the normalized settings document (see <see cref="SiteSettings"/>).</summary>
    public string Settings { get; set; } = "{}";

    /// <summary>Gets or sets <c>manual</c>, <c>auto</c> or <c>on_release</c>.</summary>
    public string RepublishMode { get; set; } = SiteRules.ManualMode;

    /// <summary>Gets or sets the principal automatic rebuilds run as, while the mode is <c>auto</c>.</summary>
    public PrincipalId? AutoPrincipalId { get; set; }

    /// <summary>Gets or sets how long an edit settles before an automatic rebuild, in seconds.</summary>
    public int DebounceSeconds { get; set; } = SiteRules.DefaultDebounceSeconds;

    /// <summary>Gets or sets <c>draft</c>, <c>published</c> or <c>unpublished</c>.</summary>
    public string Status { get; set; } = SiteRules.DraftStatus;

    /// <summary>Gets or sets the build the hostnames currently point at.</summary>
    public Guid? LiveBuildId { get; set; }

    /// <summary>Gets or sets the hostname canonical links use; null means the default hostname.</summary>
    public string? PrimaryHostname { get; set; }

    /// <summary>Gets or sets the operator's first-publish approval: null, <c>pending</c>, <c>approved</c> or <c>rejected</c>.</summary>
    public string? ApprovalState { get; set; }

    /// <summary>Gets or sets the manager who asked for approval; the approved publish runs as them.</summary>
    public PrincipalId? ApprovalRequestedBy { get; set; }

    /// <summary>Gets or sets when approval was asked for.</summary>
    public DateTimeOffset? ApprovalRequestedAt { get; set; }

    /// <summary>Gets or sets the operator who decided.</summary>
    public PrincipalId? ApprovalDecidedBy { get; set; }

    /// <summary>Gets or sets when the operator decided.</summary>
    public DateTimeOffset? ApprovalDecidedAt { get; set; }

    /// <summary>Gets or sets the operator's note, shown to the managers.</summary>
    public string? ApprovalNote { get; set; }

    /// <summary>Gets the principal who created the site.</summary>
    public required PrincipalId CreatedBy { get; init; }

    /// <summary>Gets when the site was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets or sets when the site last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A hostname that resolves to a site. Globally unique.</summary>
public sealed class SiteHostname
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the lowercase hostname.</summary>
    public required string Hostname { get; init; }

    /// <summary>Gets the site it resolves to.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets <c>default</c> (derived from the slug) or <c>custom</c>. Any non-primary hostname is an alias.</summary>
    public required string Kind { get; init; }

    /// <summary>Gets or sets when ownership was verified; only verified or default hosts get host manifests.</summary>
    public DateTimeOffset? VerifiedAt { get; set; }

    /// <summary>Gets when the hostname was added.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the per-claim token the verification TXT record must hold; custom hostnames only.</summary>
    public string? VerificationToken { get; init; }

    /// <summary>Gets or sets how a non-primary hostname answers: <c>serve</c> (200) or <c>redirect</c> (308 to the primary).</summary>
    public string ServeMode { get; set; } = SiteHostnameRules.ServeMode;

    /// <summary>Gets or sets when the DNS records were last checked.</summary>
    public DateTimeOffset? CheckedAt { get; set; }

    /// <summary>Gets or sets how many checks in a row a verified hostname has failed.</summary>
    public int CheckFailures { get; set; }

    /// <summary>Gets or sets a short code for what the last check found wrong, or null.</summary>
    public string? CheckError { get; set; }

    /// <summary>Gets or sets the Cloudflare records Nix created for this hostname, as JSON; null when unmanaged.</summary>
    public string? ManagedRecords { get; set; }
}

/// <summary>An item the manager keeps out of the site, with everything under it.</summary>
public sealed class SiteExclusion
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets the excluded item.</summary>
    public required ItemId ItemId { get; init; }
}

/// <summary>A collection whose children are dated posts; a child with no date, or a future date, is withheld.</summary>
public sealed class SiteDatedCollectionSetting
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets the collection item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the property holding each child's publication date.</summary>
    public required string DateProperty { get; init; }

    /// <summary>Gets the property holding each child's tags, if any.</summary>
    public string? TagsProperty { get; init; }

    /// <summary>Gets the property holding each child's cover image, if any.</summary>
    public string? CoverProperty { get; init; }

    /// <summary>Gets the property holding each child's summary, if any.</summary>
    public string? SummaryProperty { get; init; }
}

/// <summary>The stable public path of one item. Once published a path never changes silently.</summary>
public sealed class SitePage
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets the page's item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets or sets the path, <c>/</c> or <c>/a/b/</c>.</summary>
    public required string Path { get; set; }

    /// <summary>Gets or sets whether a manager chose the path, so a refresh never re-derives it.</summary>
    public bool Pinned { get; set; }

    /// <summary>Gets when the path was first assigned.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets or sets when the path last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A permanent redirect from a path that was once published to the item that now answers it.</summary>
public sealed class SiteRedirect
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets the old path.</summary>
    public required string FromPath { get; init; }

    /// <summary>Gets the item whose current path the old one redirects to.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets when the redirect was recorded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>One build of a site: an immutable manifest plus the objects a worker wrote for it.</summary>
public sealed class SiteBuild
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the build's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets or sets <c>queued</c>, <c>sealed</c>, <c>live</c>, <c>superseded</c>, <c>failed</c> or <c>purged</c>.</summary>
    public required string Status { get; set; }

    /// <summary>Gets the <c>site.build</c> worker job that builds it.</summary>
    public required Guid JobId { get; init; }

    /// <summary>Gets the principal whose permissions the build ran under.</summary>
    public required PrincipalId PublisherId { get; init; }

    /// <summary>Gets <c>manual</c> or <c>auto</c>.</summary>
    public required string Origin { get; init; }

    /// <summary>Gets the caller's key making a repeated publish return the same build.</summary>
    public required string IdempotencyKey { get; init; }

    /// <summary>Gets the manifest header served to the worker.</summary>
    public required string Header { get; init; }

    /// <summary>Gets the number of pages in the manifest.</summary>
    public required int PageCount { get; init; }

    /// <summary>Gets or sets the number of objects sealed.</summary>
    public int FileCount { get; set; }

    /// <summary>Gets or sets the bytes sealed.</summary>
    public long TotalBytes { get; set; }

    /// <summary>Gets or sets what the build could not represent, as a JSON array of strings.</summary>
    public string Loss { get; set; } = "[]";

    /// <summary>Gets or sets the digest of the sealed file index.</summary>
    public string? BuildIndexSha256 { get; set; }

    /// <summary>Gets or sets the purge this build's objects belong to, once it is retired.</summary>
    public Guid? PurgeId { get; set; }

    /// <summary>Gets when the build was requested.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets or sets when the worker sealed it.</summary>
    public DateTimeOffset? SealedAt { get; set; }

    /// <summary>Gets or sets when it went live.</summary>
    public DateTimeOffset? ActivatedAt { get; set; }
}

/// <summary>One page of a build's manifest. Immutable once written.</summary>
public sealed class SiteBuildPage
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the build.</summary>
    public required Guid BuildId { get; init; }

    /// <summary>Gets the pre-order position, from zero.</summary>
    public required int Ordinal { get; init; }

    /// <summary>Gets the page's item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the parent item, when the parent is itself a page.</summary>
    public ItemId? ParentItemId { get; init; }

    /// <summary>Gets the public path.</summary>
    public required string Path { get; init; }

    /// <summary>Gets the title at build time.</summary>
    public required string Title { get; init; }

    /// <summary>Gets the item type.</summary>
    public required string Type { get; init; }

    /// <summary>Gets the sibling order key.</summary>
    public required long Seq { get; init; }

    /// <summary>Gets when the item was created.</summary>
    public required DateTimeOffset ItemCreatedAt { get; init; }

    /// <summary>Gets when the item last changed.</summary>
    public required DateTimeOffset ItemUpdatedAt { get; init; }

    /// <summary>Gets the item's properties as JSON.</summary>
    public required string Properties { get; init; }

    /// <summary>Gets the effective schema snapshot as JSON, when the page has views.</summary>
    public string? Schema { get; init; }

    /// <summary>Gets the view set snapshot as JSON, when the page has views.</summary>
    public string? Views { get; init; }

    /// <summary>Gets the chart snapshot as JSON, only when nothing under the container is hidden.</summary>
    public string? Chart { get; init; }

    /// <summary>Gets the content document identity.</summary>
    public Guid? DocId { get; init; }

    /// <summary>Gets the content position the body is read at.</summary>
    public long? ContentSeq { get; init; }

    /// <summary>Gets the dated collection the page is a post of.</summary>
    public ItemId? DatedCollectionId { get; init; }

    /// <summary>Gets the post's publication instant.</summary>
    public DateTimeOffset? PublishedAt { get; init; }

    /// <summary>Gets the property images resolved at publish time, as a JSON array.</summary>
    public required string PropertyFiles { get; init; }
}

/// <summary>A file a build may copy into its output. Insert-only, and refused once the build is sealed.</summary>
public sealed class SiteBuildFile
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the build.</summary>
    public required Guid BuildId { get; init; }

    /// <summary>Gets the page that references the file.</summary>
    public required ItemId SourceItemId { get; init; }

    /// <summary>Gets the file item.</summary>
    public required ItemId FileItemId { get; init; }

    /// <summary>Gets the file version that was current when it was recorded.</summary>
    public required Guid FileVersionId { get; init; }

    /// <summary>Gets the content digest.</summary>
    public required string Sha256 { get; init; }

    /// <summary>Gets the media type.</summary>
    public required string MediaType { get; init; }

    /// <summary>Gets the size in bytes.</summary>
    public required long ByteLength { get; init; }

    /// <summary>Gets when it was recorded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>One object a build wrote to the sites bucket.</summary>
public sealed class SiteBuildObject
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the build.</summary>
    public required Guid BuildId { get; init; }

    /// <summary>Gets the object key.</summary>
    public required string Key { get; init; }

    /// <summary>Gets the content digest.</summary>
    public required string Sha256 { get; init; }

    /// <summary>Gets the size in bytes.</summary>
    public required long ByteLength { get; init; }

    /// <summary>Gets <c>build</c> (under the build prefix) or <c>asset</c> (shared across builds).</summary>
    public required string Kind { get; init; }

    /// <summary>Gets when it was recorded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>
/// A set of host-manifest writes or deletes that moves a site's hostnames, applied by a worker.
/// </summary>
public sealed class SiteActivation
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the activation's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the site.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Gets the worker job that applies it.</summary>
    public required Guid JobId { get; init; }

    /// <summary>Gets the build the hostnames will point at (the live one for an unpublish).</summary>
    public required Guid BuildId { get; init; }

    /// <summary>Gets <c>publish</c>, <c>rollback</c> or <c>unpublish</c>.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the monotonic generation written into each host manifest.</summary>
    public required int Generation { get; init; }

    /// <summary>Gets the operations as a JSON array of <c>{op, hostname, key, body, sha256, byteLength}</c>.</summary>
    public required string Ops { get; init; }

    /// <summary>Gets when the activation was planned.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets or sets when the worker confirmed the operations.</summary>
    public DateTimeOffset? AppliedAt { get; set; }
}

/// <summary>A principal an administrator allowed to decide first publishes, beside <c>Nix:Sites:Operators</c>.</summary>
public sealed class SiteOperatorGrant
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the approver.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets who granted it.</summary>
    public required PrincipalId GrantedBy { get; init; }

    /// <summary>Gets when it was granted.</summary>
    public required DateTimeOffset GrantedAt { get; init; }
}
