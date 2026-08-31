using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Templates;

/// <summary>
/// Template catalog and staging persistence. Every public method assumes the authenticated,
/// tenant-scoped transaction established by the request pipeline.
/// </summary>
public sealed partial class TemplateStore :
    ITemplateCatalogStore,
    ITemplateDraftStore,
    ITemplateStagingStore,
    ITemplateApplicationStore,
    ITemplateManagedStore,
    ITemplateAuthorizationStore
{
    private const int MaximumTemplateItems = 200;
    private const int MaximumTemplateDepth = 32;
    private const int MaximumCatalogTemplates = 1000;
    private const int MaximumStageSweepEntries = 25;
    private const int MaximumManagedBatchMappings = MaximumCatalogTemplates * MaximumTemplateItems;
    private const int RetainedManagedOperationHistory = 8;
    private const int MaximumManagedOperationHistory = 16;
    private const int DeletionBatchSize = 256;
    private static readonly TimeSpan StagingLifetime = TimeSpan.FromMinutes(30);

    private readonly NixDbContext _database;
    private readonly IPermissionResolver _permissions;
    private readonly ISchemaResolver _schemas;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;
    private readonly TemplateDefinitionValidator _validator;
    private readonly TemplateMergePlanner _mergePlanner;

    /// <summary>Initializes the store.</summary>
    public TemplateStore(
        NixDbContext database,
        IPermissionResolver permissions,
        ISchemaResolver schemas,
        INixSessionContextAccessor session,
        TimeProvider clock,
        TemplateDefinitionValidator validator,
        TemplateMergePlanner mergePlanner)
    {
        ArgumentNullException.ThrowIfNull(database);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(validator);
        ArgumentNullException.ThrowIfNull(mergePlanner);

        _database = database;
        _permissions = permissions;
        _schemas = schemas;
        _session = session;
        _clock = clock;
        _validator = validator;
        _mergePlanner = mergePlanner;
    }

    private NixSessionContext Context => _session.Current
        ?? throw new InvalidOperationException("Template work requires an authenticated tenant session.");

    private async ValueTask<bool> IsManagedTemplatePrincipalAsync(CancellationToken cancellationToken) =>
        await _database.Principals.AnyAsync(
            principal => principal.Id == Context.PrincipalId
                && principal.Kind == Nix.Domain.Identity.PrincipalKind.Service
                && principal.CanManageTemplates,
            cancellationToken).ConfigureAwait(false);

}
