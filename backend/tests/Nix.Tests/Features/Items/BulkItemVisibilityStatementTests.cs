using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Items;

/// <summary>The copied bulk-read predicates retain the same fail-closed visibility contract.</summary>
public sealed class BulkItemVisibilityStatementTests
{
    public static TheoryData<string, string, int> Statements => new()
    {
        { nameof(GraphSql.WorkspaceGraph), GraphSql.WorkspaceGraph, 1 },
        { nameof(SearchSql.MatchingItems), SearchSql.MatchingItems, 1 },
        { nameof(SearchSql.ReadableItemsById), SearchSql.ReadableItemsById, 1 },
        { nameof(SearchSql.ItemsLinkingTo), SearchSql.ItemsLinkingTo, 1 },
        { nameof(BookmarkSql.ListShelf), BookmarkSql.ListShelf, 1 },
        { nameof(BookmarkSql.Keep), BookmarkSql.Keep, 1 },
        {
            nameof(QuerySql),
            QuerySql.Compile([], QueryOrder.Recency, new DateOnly(2026, 8, 22)).Sql,
            1
        },
        { nameof(CalendarSql.WorkspaceCalendar), CalendarSql.WorkspaceCalendar, 1 },
        {
            nameof(RecurrenceSql.WorkspaceRecurrenceCandidates),
            RecurrenceSql.WorkspaceRecurrenceCandidates,
            1
        },
    };

    [Theory]
    [MemberData(nameof(Statements))]
    public void Every_bulk_item_read_rejects_a_non_visible_proper_ancestor(
        string name,
        string sql,
        int expectedPredicates)
    {
        _ = name;
        ArgumentNullException.ThrowIfNull(sql);

        Assert.Equal(expectedPredicates, Count(sql, "LEFT JOIN LATERAL"));
        Assert.Equal(expectedPredicates, Count(sql, "visibility_edge.depth > 0"));
        Assert.Equal(expectedPredicates, Count(sql, "visibility_ancestor.tenant_id = @tenant_id"));
        Assert.Equal(expectedPredicates, Count(sql, "stored_ancestor.template_id IS NOT NULL"));
        Assert.Equal(
            expectedPredicates,
            Count(sql, "stored_ancestor.lifecycle_state IS DISTINCT FROM 'active'"));
        Assert.Equal(expectedPredicates, Count(sql, "LIMIT 1\n"));
        Assert.Equal(expectedPredicates, Count(sql, "OFFSET 0"));
    }

    [Fact]
    public void Matching_search_results_are_visibility_checked_once_after_both_match_arms()
    {
        Assert.Contains("ranked AS (", SearchSql.MatchingItems, StringComparison.Ordinal);
        Assert.Equal(1, Count(SearchSql.MatchingItems, "LEFT JOIN LATERAL"));
    }

    private static int Count(string text, string value)
    {
        var count = 0;
        var offset = 0;

        while ((offset = text.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += value.Length;
        }

        return count;
    }
}
