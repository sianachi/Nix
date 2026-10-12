using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>An item the eligibility statement kept: everything a manifest page is built from.</summary>
/// <param name="Id">The item.</param>
/// <param name="ParentId">Its parent item, which may lie outside the site for the root.</param>
/// <param name="Type">The item type.</param>
/// <param name="Seq">The sibling order key.</param>
/// <param name="Properties">The properties JSON, if any.</param>
/// <param name="Schema">The declared schema JSON, if any.</param>
/// <param name="Views">The stored views JSON, if any.</param>
/// <param name="CreatedAt">When the item was created.</param>
/// <param name="LastModifiedAt">When the item or its body last changed.</param>
/// <param name="DocId">The content document, if the item has a body.</param>
/// <param name="HeadSeq">The document's head position, if it has a body.</param>
public sealed record EligiblePage(
    ItemId Id,
    ItemId? ParentId,
    string Type,
    long Seq,
    string? Properties,
    string? Schema,
    string? Views,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastModifiedAt,
    Guid? DocId,
    long? HeadSeq);

/// <summary>An image the publisher may copy into a site, at its current version.</summary>
/// <param name="FileItemId">The file item.</param>
/// <param name="FileVersionId">The current version.</param>
/// <param name="Sha256">The content digest.</param>
/// <param name="MediaType">The media type.</param>
/// <param name="ByteLength">The size in bytes.</param>
/// <param name="ObjectKey">The version's key in the private object store; never leaves Core.</param>
/// <param name="FileName">The version's file name, which a published download is named after.</param>
public sealed record SiteFileCandidate(
    ItemId FileItemId,
    Guid FileVersionId,
    string Sha256,
    string MediaType,
    long ByteLength,
    string ObjectKey,
    string FileName);

/// <summary>A build with the status of the worker job that builds it.</summary>
/// <param name="Build">The build row.</param>
/// <param name="JobStatus">The job's status, if the job row is still there.</param>
/// <param name="JobErrorCode">The job's failure code, if it failed.</param>
public sealed record SiteBuildView(SiteBuild Build, string? JobStatus, string? JobErrorCode);

/// <summary>One page of a site's path table, with the item's current title.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Path">The published path.</param>
/// <param name="Pinned">Whether a manager chose it.</param>
/// <param name="Title">The item's current title, if it can still be read.</param>
public sealed record SitePageRow(ItemId ItemId, string Path, bool Pinned, string? Title);

/// <summary>The outcome of a write that can collide with another site's globally unique value.</summary>
public enum SiteWriteOutcome
{
    /// <summary>The rows were written.</summary>
    Written,

    /// <summary>The slug belongs to another site.</summary>
    SlugTaken,

    /// <summary>The root already has a site.</summary>
    RootTaken,

    /// <summary>A hostname belongs to another site.</summary>
    HostnameTaken,
}

/// <summary>The outcome of recording a file against a build.</summary>
public enum SiteFileRecording
{
    /// <summary>The row was written, or already existed.</summary>
    Recorded,

    /// <summary>The build is no longer queued.</summary>
    BuildClosed,
}

/// <summary>
/// Storage for sites, their builds and the worker's view of them. Every method runs inside the
/// current unit of work, under its tenant and principal; nothing here decides permissions.
/// </summary>
public interface ISiteStore
{
    /// <summary>
    /// Takes the site's row lock for the rest of the transaction. Every change of a site's state
    /// (publish, rollback, unpublish, delete, seal, activation) takes it first, so two of them never
    /// interleave; reads made after it see what the previous holder committed.
    /// </summary>
    public ValueTask LockSiteAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Counts the sites of the current tenant.</summary>
    public ValueTask<int> CountAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Whether any site of the workspace (or, with <paramref name="rootItemId"/>, the site rooted at
    /// that item) is live or still has objects in the sites bucket. Deleting such a site's rows
    /// would leave its pages on the internet with nothing that names them.
    /// </summary>
    public ValueTask<bool> HasLiveOrStoredSiteAsync(WorkspaceId workspaceId, ItemId? rootItemId, CancellationToken cancellationToken);

    /// <summary>Whether any of the asset keys is listed by a build of an open purge, whose worker may be deleting it.</summary>
    public ValueTask<bool> IsAnyAssetPurgingAsync(IReadOnlyCollection<string> keys, CancellationToken cancellationToken);

    /// <summary>Writes everything tracked, reporting an activation generation collision instead of throwing.</summary>
    /// <returns>False when another activation already took the generation.</returns>
    public ValueTask<bool> TrySaveActivationAsync(CancellationToken cancellationToken);

    /// <summary>Reads a site without tracking it.</summary>
    public ValueTask<Site?> FindAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Reads a site for update.</summary>
    public ValueTask<Site?> FindForUpdateAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Reads the site rooted at an item.</summary>
    public ValueTask<Site?> FindByRootAsync(ItemId rootItemId, CancellationToken cancellationToken);

    /// <summary>Lists the sites of a workspace, oldest first.</summary>
    public ValueTask<IReadOnlyList<Site>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Writes a site with its default hostname, reporting a collision instead of throwing.</summary>
    public ValueTask<SiteWriteOutcome> AddAsync(Site site, SiteHostname defaultHostname, CancellationToken cancellationToken);

    /// <summary>Removes a site; its hostnames, paths and builds go with it.</summary>
    public ValueTask RemoveAsync(Site site, CancellationToken cancellationToken);

    /// <summary>Whether any build of the site still has objects that are not purged.</summary>
    public ValueTask<bool> HasUnpurgedObjectsAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Lists the hostnames of the given sites.</summary>
    public ValueTask<IReadOnlyList<SiteHostname>> ListHostnamesAsync(IReadOnlyCollection<Guid> siteIds, CancellationToken cancellationToken);

    /// <summary>Replaces the custom hostnames of a site, reporting a collision instead of throwing.</summary>
    public ValueTask<SiteWriteOutcome> ReplaceCustomHostnamesAsync(Guid siteId, IReadOnlyCollection<string> hostnames, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Lists the excluded items of a site.</summary>
    public ValueTask<IReadOnlyList<ItemId>> ListExclusionsAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Replaces the excluded items of a site.</summary>
    public ValueTask ReplaceExclusionsAsync(Site site, IReadOnlyCollection<ItemId> itemIds, CancellationToken cancellationToken);

    /// <summary>Lists the dated collections of a site.</summary>
    public ValueTask<IReadOnlyList<SiteDatedCollectionSetting>> ListDatedCollectionsAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Replaces the dated collections of a site.</summary>
    public ValueTask ReplaceDatedCollectionsAsync(Site site, IReadOnlyCollection<SiteDatedCollectionSetting> collections, CancellationToken cancellationToken);

    /// <summary>Whether every item is the root or lies under it.</summary>
    public ValueTask<bool> AreInSubtreeAsync(ItemId rootItemId, IReadOnlyCollection<ItemId> itemIds, CancellationToken cancellationToken);

    /// <summary>Lists a site's path table with current titles, in path order.</summary>
    public ValueTask<IReadOnlyList<SitePageRow>> ListPagesAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Loads the path table and redirects for update.</summary>
    public ValueTask<(List<SitePage> Pages, List<SiteRedirect> Redirects)> LoadPathsAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Starts tracking a new path row.</summary>
    public void AddPage(SitePage page);

    /// <summary>Starts tracking a new redirect.</summary>
    public void AddRedirect(SiteRedirect redirect);

    /// <summary>Stops tracking and deletes a redirect.</summary>
    public void RemoveRedirect(SiteRedirect redirect);

    /// <summary>Lists a site's builds, newest first, with their job status.</summary>
    public ValueTask<IReadOnlyList<SiteBuildView>> ListBuildsAsync(Guid siteId, int limit, CancellationToken cancellationToken);

    /// <summary>Reads one build of a site with its job status.</summary>
    public ValueTask<SiteBuildView?> FindBuildAsync(Guid siteId, Guid buildId, CancellationToken cancellationToken);

    /// <summary>Reads the build a caller's idempotency key already created, if any.</summary>
    public ValueTask<SiteBuildView?> FindBuildByKeyAsync(Guid siteId, string idempotencyKey, CancellationToken cancellationToken);

    /// <summary>Whether a build of the site is queued or sealed under a job that is still alive.</summary>
    public ValueTask<bool> HasBuildInFlightAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Whether a rollback or unpublish of the site is waiting on a worker job that is still alive.</summary>
    public ValueTask<bool> HasActivationInFlightAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Runs the eligibility statement under the publisher's session.</summary>
    public ValueTask<IReadOnlyList<EligiblePage>> EligiblePagesAsync(Site site, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Which of the containers have an active child that is not among the eligible items.</summary>
    public ValueTask<IReadOnlySet<ItemId>> ContainersWithHiddenChildrenAsync(IReadOnlyCollection<ItemId> containerIds, IReadOnlyCollection<ItemId> eligibleIds, CancellationToken cancellationToken);

    /// <summary>Resolves an image the publisher may copy into the site as of <paramref name="now"/>, or null when it is not eligible.</summary>
    public ValueTask<SiteFileCandidate?> FindFileAsync(Site site, ItemId fileItemId, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Starts tracking a build.</summary>
    public void AddBuild(SiteBuild build);

    /// <summary>Starts tracking a manifest page.</summary>
    public void AddBuildPage(SiteBuildPage page);

    /// <summary>Starts tracking a file row.</summary>
    public void AddBuildFile(SiteBuildFile file);

    /// <summary>Starts tracking an activation.</summary>
    public void AddActivation(SiteActivation activation);

    /// <summary>Starts tracking an audit event.</summary>
    public void AddAudit(AuditEvent auditEvent);

    /// <summary>Writes everything tracked.</summary>
    public ValueTask SaveAsync(CancellationToken cancellationToken);

    /// <summary>The next activation generation for a site.</summary>
    public ValueTask<int> NextGenerationAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Reads a build for update.</summary>
    public ValueTask<SiteBuild?> FindBuildForUpdateAsync(Guid buildId, CancellationToken cancellationToken);

    /// <summary>Reads the build a <c>site.build</c> job builds, for update.</summary>
    public ValueTask<SiteBuild?> FindBuildByJobAsync(Guid jobId, CancellationToken cancellationToken);

    /// <summary>Reads manifest pages after an ordinal.</summary>
    public ValueTask<IReadOnlyList<SiteBuildPage>> ListBuildPagesAsync(Guid buildId, int after, int limit, CancellationToken cancellationToken);

    /// <summary>Reads one manifest page by item.</summary>
    public ValueTask<SiteBuildPage?> FindBuildPageAsync(Guid buildId, ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Records an image against a build, idempotently.</summary>
    public ValueTask<SiteFileRecording> RecordFileAsync(SiteBuild build, ItemId sourceItemId, SiteFileCandidate file, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Lists the objects recorded for a build.</summary>
    public ValueTask<IReadOnlyList<SiteBuildObject>> ListObjectsAsync(Guid buildId, CancellationToken cancellationToken);

    /// <summary>Starts tracking an object row.</summary>
    public void AddObject(SiteBuildObject buildObject);

    /// <summary>Reads the activation a worker job applies, for update.</summary>
    public ValueTask<SiteActivation?> FindActivationByJobAsync(Guid jobId, CancellationToken cancellationToken);

    /// <summary>Makes a sealed build live: supersedes the previous live build and queues the retired builds for purge.</summary>
    /// <returns>The purge that was queued, or null when nothing was retired.</returns>
    public ValueTask<Guid?> ActivateAsync(Site site, SiteBuild build, SiteActivation activation, int buildsRetained, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Points the site back at a previous build.</summary>
    public ValueTask RollBackAsync(Site site, SiteBuild target, SiteActivation activation, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Withdraws the site and queues every build for purge.</summary>
    /// <returns>The purge that was queued, or null when there was nothing to delete.</returns>
    public ValueTask<Guid?> WithdrawAsync(Site site, SiteActivation activation, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Lists the objects of a purge that no other build still needs, after a key.</summary>
    public ValueTask<IReadOnlyList<string>> ListPurgeObjectsAsync(Guid purgeId, string? afterKey, int limit, CancellationToken cancellationToken);

    /// <summary>Forgets objects the worker deleted and marks drained builds purged.</summary>
    /// <returns>The number of object rows removed.</returns>
    public ValueTask<int> MarkPurgedAsync(Guid purgeId, IReadOnlyCollection<string> keys, CancellationToken cancellationToken);
}
