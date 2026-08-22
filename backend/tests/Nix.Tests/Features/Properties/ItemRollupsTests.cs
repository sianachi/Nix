using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Properties;

namespace Nix.Tests.Features.Properties;

/// <summary>
/// Folding a page's rollups: which declarations are read, how many queries it takes, and what an
/// item with no children is told.
/// </summary>
public sealed class ItemRollupsTests
{
    private static readonly WorkspaceId Workspace = WorkspaceId.From(Guid.NewGuid());
    private static readonly ItemId Container = ItemId.From(Guid.NewGuid());
    private static readonly ItemId First = ItemId.From(Guid.NewGuid());
    private static readonly ItemId Second = ItemId.From(Guid.NewGuid());

    [Fact]
    public async Task Every_rollup_the_schema_declares_is_folded_for_every_item()
    {
        var aggregates = new RecordingAggregates
        {
            Folds =
            {
                [new ChildAggregateKey(First, "estimate")] = new ChildAggregate(3, 3, 3, 12m, 2m, 6m, 0, 0),
            },
        };

        var handler = HandlerOver(
            aggregates,
            Rollup("hours", RollupAggregate.Sum, "estimate"),
            Rollup("tasks", RollupAggregate.Count, source: null));

        var result = await handler.HandleAsync(
            new ItemRollups(Workspace, [First, Second], Container),
            TestContext.Current.CancellationToken);

        Assert.Equal("12", result[First]["hours"]?.ToJsonString());
        Assert.Equal("0", result[Second]["hours"]?.ToJsonString());
    }

    [Fact]
    public async Task An_item_with_no_children_is_answered_rather_than_left_out()
    {
        // Zero is the answer, and it is the answer on exactly the containers whose emptiness a
        // person is checking. Leaving the item out would draw the column blank there.
        var handler = HandlerOver(
            new RecordingAggregates(),
            Rollup("tasks", RollupAggregate.Count, source: null));

        var result = await handler.HandleAsync(
            new ItemRollups(Workspace, [First], Container),
            TestContext.Current.CancellationToken);

        Assert.Equal("0", result[First]["tasks"]?.ToJsonString());
    }

    [Fact]
    public async Task Two_rollups_over_one_property_fold_it_once()
    {
        // A sum and an average of the same estimate read the same column; scanning it twice would
        // double the cost of a page for an answer already in hand.
        var aggregates = new RecordingAggregates();

        var handler = HandlerOver(
            aggregates,
            Rollup("hours", RollupAggregate.Sum, "estimate"),
            Rollup("typical", RollupAggregate.Average, "estimate"));

        await handler.HandleAsync(
            new ItemRollups(Workspace, [First], Container),
            TestContext.Current.CancellationToken);

        Assert.Equal(["estimate"], Assert.Single(aggregates.Calls).Keys);
    }

    [Fact]
    public async Task The_whole_page_is_folded_in_one_call()
    {
        var aggregates = new RecordingAggregates();

        var handler = HandlerOver(aggregates, Rollup("hours", RollupAggregate.Sum, "estimate"));

        await handler.HandleAsync(
            new ItemRollups(Workspace, [First, Second], Container),
            TestContext.Current.CancellationToken);

        var call = Assert.Single(aggregates.Calls);
        Assert.Equal([First, Second], call.Parents);
    }

    [Fact]
    public async Task A_schema_with_no_rollups_reads_nothing()
    {
        var aggregates = new RecordingAggregates();

        var handler = HandlerOver(aggregates, Property("status", PropertyType.Select));

        var result = await handler.HandleAsync(
            new ItemRollups(Workspace, [First], Container),
            TestContext.Current.CancellationToken);

        Assert.Empty(result);
        Assert.Empty(aggregates.Calls);
    }

    [Fact]
    public async Task A_page_with_no_schema_source_reads_nothing()
    {
        // The workspace roots: no container, so no schema, so nothing to fold.
        var aggregates = new RecordingAggregates();

        var handler = HandlerOver(aggregates, Rollup("hours", RollupAggregate.Sum, "estimate"));

        var result = await handler.HandleAsync(
            new ItemRollups(Workspace, [First], SchemaSource: null),
            TestContext.Current.CancellationToken);

        Assert.Empty(result);
        Assert.Empty(aggregates.Calls);
    }

    private static ItemRollupsHandler HandlerOver(
        IChildAggregates aggregates,
        params PropertyDefinition[] properties) =>
        new(
            new FixedSchema(new PropertySchema { Properties = [.. properties], Inherit = true }),
            aggregates);

    private static PropertyDefinition Property(string key, PropertyType type) =>
        new(key, key, type, ImmutableArray<string>.Empty, false);

    private static PropertyDefinition Rollup(string key, RollupAggregate aggregate, string? source) =>
        new(
            key,
            key,
            PropertyType.Rollup,
            ImmutableArray<string>.Empty,
            Required: false,
            Expression: null,
            Aggregate: aggregate,
            Source: source);

    /// <summary>One schema, whatever is asked. The resolution itself is SchemaResolver's own test.</summary>
    private sealed class FixedSchema : ISchemaResolver
    {
        private readonly PropertySchema _schema;

        public FixedSchema(PropertySchema schema) => _schema = schema;

        public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_schema);

        public ValueTask<PropertySchema> ResolveForChildrenAsync(ItemId? parentId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_schema);
    }

    /// <summary>
    /// The test fake for the fold port: answers from a dictionary and records what it was asked.
    /// </summary>
    /// <remarks>
    /// How many calls it took and what they carried is half of what these tests exist to assert -
    /// a rollup read that fanned out per item would still produce the right numbers.
    /// </remarks>
    private sealed class RecordingAggregates : IChildAggregates
    {
        public Dictionary<ChildAggregateKey, ChildAggregate> Folds { get; } = [];

        public List<(IReadOnlyList<ItemId> Parents, IReadOnlyList<string> Keys)> Calls { get; } = [];

        public ValueTask<IReadOnlyDictionary<ChildAggregateKey, ChildAggregate>> FoldAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            IReadOnlyList<string> keys,
            CancellationToken cancellationToken)
        {
            Calls.Add((parents, keys));
            return ValueTask.FromResult<IReadOnlyDictionary<ChildAggregateKey, ChildAggregate>>(Folds);
        }

        public ValueTask<ChildBuckets> BucketAsync(
            WorkspaceId workspaceId,
            ItemId parent,
            string groupKey,
            string? measureKey,
            int limit,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new ChildBuckets([], 0, 0));
    }
}
