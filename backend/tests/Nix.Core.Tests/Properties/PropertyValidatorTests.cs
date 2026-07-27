using System.Collections.Immutable;
using System.Text;
using Nix.Core.Properties;

namespace Nix.Core.Tests.Properties;

/// <summary>
/// What a property bag has to satisfy before it is written, and - just as importantly - what it
/// does not.
/// </summary>
/// <remarks>
/// <para>
/// The asymmetry is the point. Declared keys are checked strictly; undeclared keys are neither
/// checked nor mentioned. That is ADR-0007 section 4, and the reason is that a schema is edited by
/// people: if removing a property made every stored value illegal, one schema edit would break the
/// next write to every item beneath it, on data the writer never touched. It is also the only
/// reason <c>title</c> works, since it lives in the bag and no schema declares it.
/// </para>
/// <para>
/// The per-type cases are written as accept-and-reject pairs rather than accept-only, because every
/// one of these checks is a place where "anything JSON can hold" would pass. A date property that
/// accepted an instant, or a URL property that accepted <c>javascript:</c>, would be found by a
/// person rather than by a test.
/// </para>
/// </remarks>
public sealed class PropertyValidatorTests
{
    [Fact]
    public void A_key_the_schema_does_not_declare_is_neither_checked_nor_reported()
    {
        // The single most important assertion in the file. Every value here would be refused if it
        // were declared - a number where text is expected, an object, a value that is not among any
        // options - and none of them is this schema's business. A property dropped from a schema
        // stops being validated and stops being shown, and comes back intact if the schema does.
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", options: ["Todo"]));

        var bag =
            """
            {"status":"Todo","title":"Quarterly plan","retired":42,
             "legacy":{"nested":[1,2,3]},"stage":"Shipped"}
            """;

        Assert.Empty(PropertyValidator.Validate(bag, schema));
    }

    [Fact]
    public void An_item_under_no_schema_at_all_may_hold_whatever_it_already_held()
    {
        // The state every item is in before anybody authors a schema, and the state a subtree
        // returns to when one is deleted. Neither is a reason to refuse the next rename.
        var bag = """{"title":"Notes","status":"Doing","estimate":3}""";

        Assert.Empty(PropertyValidator.Validate(bag, PropertySchema.Empty));
    }

    [Fact]
    public void A_required_property_with_no_value_at_all_is_refused()
    {
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        var violation = Assert.Single(PropertyValidator.Validate("""{"title":"Notes"}""", schema));

        Assert.Equal("status", violation.Key);
        Assert.Equal("Status is required.", violation.Reason);
    }

    [Fact]
    public void A_required_property_set_to_null_is_refused_in_the_same_terms()
    {
        // Null is what a client clearing a field sends, so it has to mean absent. If it meant
        // "present but empty", every required property in the system would be satisfiable by
        // sending null - a rule the interface enforces and the server does not.
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        var violation = Assert.Single(PropertyValidator.Validate("""{"status":null}""", schema));

        Assert.Equal("status", violation.Key);
        Assert.Equal("Status is required.", violation.Reason);
    }

    [Fact]
    public void An_optional_property_set_to_null_is_a_property_that_is_not_set()
    {
        var schema = SchemaOf(Property("due", PropertyType.Date, "Due date"));

        Assert.Empty(PropertyValidator.Validate("""{"due":null}""", schema));
    }

    [Fact]
    public void A_bag_with_no_bag_at_all_still_owes_the_required_properties()
    {
        var schema = SchemaOf(
            Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]),
            Property("due", PropertyType.Date, "Due date"));

        Assert.Single(PropertyValidator.Validate(null, schema));
        Assert.Empty(PropertyValidator.Validate(null, SchemaOf(Property("due", PropertyType.Date, "Due date"))));
    }

    [Fact]
    public void Every_violation_is_reported_rather_than_only_the_first()
    {
        // A form with three bad fields should say so once. Stopping at the first would make fixing
        // a schema a sequence of round trips, each revealing one more thing.
        var schema = SchemaOf(
            Property("status", PropertyType.Select, "Status", options: ["Todo"]),
            Property("due", PropertyType.Date, "Due date"),
            Property("estimate", PropertyType.Number, "Estimate"),
            Property("owner", PropertyType.Text, "Owner", required: true));

        var violations = PropertyValidator.Validate(
            """{"status":"Shipped","due":"yesterday","estimate":"three"}""",
            schema);

        string[] expected = ["status", "due", "estimate", "owner"];
        Assert.Equal(expected, violations.Select(violation => violation.Key).ToArray());
    }

    [Fact]
    public void A_violation_names_the_property_by_its_label_rather_than_its_key()
    {
        // The reason goes in a problem document and from there onto a form. "Due date must be a
        // date" is actionable; "due_at_utc must be a date" is a leak of the storage key.
        var schema = SchemaOf(Property("due_at", PropertyType.Date, "Due date"));

        var violation = Assert.Single(PropertyValidator.Validate("""{"due_at":"2026-13-01"}""", schema));

        Assert.Equal("due_at", violation.Key);
        Assert.Equal("Due date must be a date, as yyyy-MM-dd.", violation.Reason);
    }

    [Theory]
    [InlineData("\"\"")]
    [InlineData("\"a line of text\"")]
    public void Text_accepts_a_JSON_string(string value) => AssertAccepted(PropertyType.Text, value);

    [Theory]
    [InlineData("42")]
    [InlineData("true")]
    [InlineData("[\"text\"]")]
    [InlineData("{\"text\":\"text\"}")]
    public void Text_refuses_anything_that_is_not_one(string value) =>
        AssertRefused(PropertyType.Text, value, "Field must be text.");

    [Theory]
    [InlineData("0")]
    [InlineData("-3")]
    [InlineData("1.5")]
    [InlineData("1e3")]
    public void Number_accepts_a_JSON_number(string value) => AssertAccepted(PropertyType.Number, value);

    [Theory]
    [InlineData("\"1\"")]
    [InlineData("true")]
    [InlineData("[1]")]
    public void Number_refuses_a_value_that_merely_looks_numeric(string value) =>
        AssertRefused(PropertyType.Number, value, "Field must be a number.");

    [Theory]
    [InlineData("true")]
    [InlineData("false")]
    public void Checkbox_accepts_a_JSON_boolean(string value) => AssertAccepted(PropertyType.Checkbox, value);

    [Theory]
    [InlineData("\"true\"")]
    [InlineData("1")]
    [InlineData("0")]
    public void Checkbox_refuses_the_usual_stand_ins_for_one(string value) =>
        AssertRefused(PropertyType.Checkbox, value, "Field must be true or false.");

    [Theory]
    [InlineData("\"2026-07-27\"")]
    [InlineData("\"2000-02-29\"")]
    public void Date_accepts_a_calendar_day(string value) => AssertAccepted(PropertyType.Date, value);

    [Theory]
    [InlineData("\"2026-07-27T09:00:00Z\"")]
    [InlineData("\"2026-7-27\"")]
    [InlineData("\"27/07/2026\"")]
    [InlineData("\"2026-02-30\"")]
    [InlineData("\"2026-13-01\"")]
    [InlineData("20260727")]
    [InlineData("\"\"")]
    public void Date_refuses_anything_that_is_not_exactly_a_calendar_day(string value) =>
        AssertRefused(PropertyType.Date, value, "Field must be a date, as yyyy-MM-dd.");

    [Fact]
    public void A_date_with_a_time_on_it_is_refused_rather_than_truncated()
    {
        // A property that means "the 3rd" must not become the 2nd for a reader in another zone,
        // which is exactly what accepting an instant and rendering it locally would do. Refusing
        // is the only answer that keeps the value meaning one day everywhere.
        AssertRefused(PropertyType.Date, "\"2026-07-27T00:00:00+13:00\"", "Field must be a date, as yyyy-MM-dd.");
    }

    [Theory]
    [InlineData("\"https://example.test/path?q=1\"")]
    [InlineData("\"http://example.test\"")]
    public void Url_accepts_an_absolute_web_address(string value) => AssertAccepted(PropertyType.Url, value);

    [Theory]
    [InlineData("\"example.test\"")]
    [InlineData("\"/relative/path\"")]
    [InlineData("\"ftp://example.test/file\"")]
    [InlineData("\"mailto:someone@example.test\"")]
    [InlineData("42")]
    public void Url_refuses_an_address_that_is_relative_or_off_the_web(string value) =>
        AssertRefused(PropertyType.Url, value, "Field must be an http or https address.");

    [Fact]
    public void Url_refuses_a_scheme_that_would_execute_when_clicked()
    {
        // One render away from being a link somebody clicks. The schema is the only place this can
        // be stopped once, for every view that ever displays the property.
        AssertRefused(PropertyType.Url, "\"javascript:alert(1)\"", "Field must be an http or https address.");
    }

    [Fact]
    public void Select_accepts_a_value_the_property_declared()
    {
        var schema = SchemaOf(Property("field", PropertyType.Select, "Field", options: ["Todo", "Done"]));

        Assert.Empty(PropertyValidator.Validate("""{"field":"Done"}""", schema));
    }

    [Theory]
    [InlineData("\"Shipped\"", "Field does not offer 'Shipped'.")]
    [InlineData("\"done\"", "Field does not offer 'done'.")]
    [InlineData("[\"Done\"]", "Field must be one of its options.")]
    [InlineData("7", "Field must be one of its options.")]
    public void Select_refuses_a_value_the_property_never_declared(string value, string reason)
    {
        var schema = SchemaOf(Property("field", PropertyType.Select, "Field", options: ["Todo", "Done"]));

        var violation = Assert.Single(PropertyValidator.Validate($$"""{"field":{{value}}}""", schema));

        Assert.Equal(reason, violation.Reason);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[\"Todo\"]")]
    [InlineData("[\"Todo\",\"Done\"]")]
    public void A_multi_select_accepts_any_number_of_declared_values(string value)
    {
        var schema = SchemaOf(Property("field", PropertyType.MultiSelect, "Field", options: ["Todo", "Done"]));

        Assert.Empty(PropertyValidator.Validate($$"""{"field":{{value}}}""", schema));
    }

    [Theory]
    [InlineData("\"Todo\"", "Field must be a list of its options.")]
    [InlineData("{}", "Field must be a list of its options.")]
    [InlineData("[\"Todo\",\"Shipped\"]", "Field does not offer 'Shipped'.")]
    // A non-string member is named as what it is rather than as "null". A message that called a
    // number "null" would send somebody checking their options list for an entry that was never
    // the problem.
    [InlineData("[null]", "Field takes text values; 'null' is not one.")]
    [InlineData("[7]", "Field takes text values; '7' is not one.")]
    public void A_multi_select_refuses_a_list_it_did_not_declare_every_member_of(
        string value,
        string reason)
    {
        var schema = SchemaOf(Property("field", PropertyType.MultiSelect, "Field", options: ["Todo", "Done"]));

        var violation = Assert.Single(PropertyValidator.Validate($$"""{"field":{{value}}}""", schema));

        Assert.Equal(reason, violation.Reason);
    }

    [Theory]
    [InlineData("[1,2,3]")]
    [InlineData("\"a bag\"")]
    [InlineData("42")]
    [InlineData("true")]
    public void A_bag_that_is_not_a_JSON_map_is_refused_as_a_whole(string properties)
    {
        // Reported against the empty key because no single property is at fault. The endpoint turns
        // that into a problem document about the request body rather than about a field.
        var violation = Assert.Single(PropertyValidator.Validate(properties, PropertySchema.Empty));

        Assert.Equal(string.Empty, violation.Key);
        Assert.Equal("The properties must be a JSON object.", violation.Reason);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("{\"status\":}")]
    [InlineData("not json at all")]
    [InlineData("")]
    [InlineData("   ")]
    public void A_bag_that_is_not_valid_JSON_is_refused_rather_than_thrown_over(string properties)
    {
        // A parse failure here is a bad request, not a fault: the bytes came from a client, so the
        // answer is a 400 naming the problem, never an exception surfacing as a 500.
        var violation = Assert.Single(PropertyValidator.Validate(properties, PropertySchema.Empty));

        Assert.Equal(string.Empty, violation.Key);
        Assert.Equal("The properties are not valid JSON.", violation.Reason);
    }

    [Fact]
    public void A_bag_at_exactly_the_ceiling_is_accepted()
    {
        var bag = BagOfSize(PropertyValidator.MaximumBytes, 'a');

        Assert.Equal(PropertyValidator.MaximumBytes, Encoding.UTF8.GetByteCount(bag));
        Assert.Empty(PropertyValidator.Validate(bag, PropertySchema.Empty));
    }

    [Fact]
    public void A_bag_over_the_ceiling_is_refused_before_anything_else_is_looked_at()
    {
        // Checked here as well as by the column so an oversized bag is a problem document naming
        // the limit, rather than a constraint violation arriving as a 500. It is also the reason
        // the size check comes first: a bag too large to store is not worth parsing.
        var bag = BagOfSize(PropertyValidator.MaximumBytes + 1, 'a');
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        var violation = Assert.Single(PropertyValidator.Validate(bag, schema));

        Assert.Equal(string.Empty, violation.Key);
        Assert.Equal($"A property bag may be at most {PropertyValidator.MaximumBytes} bytes.", violation.Reason);
    }

    [Fact]
    public void The_ceiling_counts_bytes_so_text_outside_ASCII_reaches_it_sooner()
    {
        // The column is bounded in bytes, and a limit measured in characters would let a bag of
        // accented text through here and be refused by Postgres afterwards.
        var bag = BagOfSize(PropertyValidator.MaximumBytes, 'é');

        Assert.True(Encoding.UTF8.GetByteCount(bag) > PropertyValidator.MaximumBytes);
        Assert.Single(PropertyValidator.Validate(bag, PropertySchema.Empty));
    }

    private static void AssertAccepted(PropertyType type, string value)
    {
        var schema = SchemaOf(Property("field", type, "Field"));

        Assert.Empty(PropertyValidator.Validate($$"""{"field":{{value}}}""", schema));
    }

    private static void AssertRefused(PropertyType type, string value, string reason)
    {
        var schema = SchemaOf(Property("field", type, "Field"));

        var violation = Assert.Single(PropertyValidator.Validate($$"""{"field":{{value}}}""", schema));

        Assert.Equal("field", violation.Key);
        Assert.Equal(reason, violation.Reason);
    }

    /// <summary>A syntactically valid bag whose text is exactly <paramref name="length"/> characters.</summary>
    private static string BagOfSize(int length, char filler)
    {
        const string Opening = "{\"title\":\"";
        const string Closing = "\"}";

        return string.Concat(
            Opening,
            new string(filler, length - Opening.Length - Closing.Length),
            Closing);
    }

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Property(
        string key,
        PropertyType type,
        string label,
        bool required = false,
        ImmutableArray<string> options = default) =>
        new(key, label, type, options.IsDefault ? [] : options, required);

    [Theory]
    [InlineData("2026-03-17T09:00:00+00:00[Europe/London]")]
    [InlineData("2026-07-17T09:00:00+01:00[Europe/London]")]
    [InlineData("2026-03-17T09:00:00Z[Etc/UTC]")]
    [InlineData("2026-03-17T09:00:00-10:00[Pacific/Honolulu]")]
    public void A_timestamp_keeps_its_local_time_and_its_zone(string text)
    {
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        Assert.Empty(PropertyValidator.Validate($$"""{"at":"{{text}}"}""", schema));
    }

    [Fact]
    public void The_same_wall_time_carries_a_different_offset_on_either_side_of_a_clock_change()
    {
        // Both are 09:00 in London, and they are an hour apart as instants. This is the whole
        // reason the zone is stored rather than only the moment: keeping the instant alone would
        // turn a 09:00 standup into a 10:00 one the day the clocks went forward.
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        Assert.Empty(
            PropertyValidator.Validate("""{"at":"2026-03-17T09:00:00+00:00[Europe/London]"}""", schema));
        Assert.Empty(
            PropertyValidator.Validate("""{"at":"2026-07-17T09:00:00+01:00[Europe/London]"}""", schema));
    }

    [Fact]
    public void An_offset_the_zone_was_not_using_is_refused()
    {
        // London is on +01:00 in July. A value claiming +00:00 renders as one time if the offset is
        // believed and another if the zone is, and there is no way to tell which was meant.
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        var violations =
            PropertyValidator.Validate("""{"at":"2026-07-17T09:00:00+00:00[Europe/London]"}""", schema);

        Assert.Contains("Europe/London", Assert.Single(violations).Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("2026-03-17T09:00:00+00:00")]
    [InlineData("2026-03-17T09:00:00Z")]
    [InlineData("2026-03-17T09:00:00")]
    public void A_timestamp_without_a_zone_is_refused(string text)
    {
        // An offset says what the clock read, not which rules it was following. It cannot survive
        // the next time those rules change, which is the failure the whole type exists to avoid.
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        Assert.Single(PropertyValidator.Validate($$"""{"at":"{{text}}"}""", schema));
    }

    [Fact]
    public void A_zone_this_build_does_not_know_is_refused_by_name()
    {
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        var violations =
            PropertyValidator.Validate("""{"at":"2026-03-17T09:00:00+00:00[Middle/Earth]"}""", schema);

        // Named, because "invalid" leaves somebody guessing whether it was the date, the offset or
        // the spelling of the zone.
        Assert.Contains("Middle/Earth", Assert.Single(violations).Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_date_still_refuses_everything_carrying_a_time()
    {
        // The two types stay distinct. A date means "the 3rd" and must not shift for a reader in
        // another zone; a timestamp means a moment and must. Letting a date accept a timestamp
        // would quietly make one of them wrong.
        var schema = SchemaOf(Property("due", PropertyType.Date, "Due"));

        Assert.Single(
            PropertyValidator.Validate("""{"due":"2026-03-17T09:00:00+00:00[Europe/London]"}""", schema));
    }
}
