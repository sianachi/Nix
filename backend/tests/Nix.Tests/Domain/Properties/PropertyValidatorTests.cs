using System.Collections.Immutable;
using System.Text;
using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

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

        Assert.Empty(PropertyValidator.ValidateSupplied(bag, schema));
    }

    [Fact]
    public void An_item_under_no_schema_at_all_may_hold_whatever_it_already_held()
    {
        // The state every item is in before anybody authors a schema, and the state a subtree
        // returns to when one is deleted. Neither is a reason to refuse the next rename.
        var bag = """{"title":"Notes","status":"Doing","estimate":3}""";

        Assert.Empty(PropertyValidator.ValidateSupplied(bag, PropertySchema.Empty));
    }

    [Fact]
    public void A_write_that_clears_a_required_property_is_refused()
    {
        // Null is what a client clearing a field sends, and the merge removes the key, so by the
        // time the bag is checked "cleared" and "never set" look identical. Only the change
        // document tells them apart - which is why the write is checked against it and not just
        // against its result.
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        var violation = Assert.Single(
            PropertyValidator.ValidateWrite(WriteOf("""{"title":"Notes"}""", """{"status":null}"""), schema));

        Assert.Equal("status", violation.Key);
        Assert.Equal("Status is required.", violation.Reason);
    }

    [Fact]
    public void A_write_is_not_refused_for_a_required_property_it_did_not_touch()
    {
        // The whole point of the goal. Declaring a property required must not write-lock the items
        // that already exist: a board drag setting "status" is not the moment to demand an "owner"
        // the board does not draw, cannot supply, and was never asked about.
        var schema = SchemaOf(
            Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]),
            Property("owner", PropertyType.Text, "Owner", required: true));

        Assert.Empty(
            PropertyValidator.ValidateWrite(
                WriteOf("""{"title":"Notes"}""", """{"status":"Todo"}"""),
                schema));
    }

    [Fact]
    public void A_write_that_sets_a_required_property_to_a_real_value_is_accepted()
    {
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        Assert.Empty(
            PropertyValidator.ValidateWrite(WriteOf(null, """{"status":"Todo"}"""), schema));
    }

    [Fact]
    public void A_write_that_clears_an_optional_property_is_a_property_that_is_not_set()
    {
        var schema = SchemaOf(Property("due", PropertyType.Date, "Due date"));

        Assert.Empty(
            PropertyValidator.ValidateWrite(WriteOf("""{"title":"Notes"}""", """{"due":null}"""), schema));
    }

    [Fact]
    public void A_write_that_names_nothing_owes_nothing()
    {
        // An empty change document is a write that touched no key, so there is no required value
        // it could be refused over. Pinned because it is the boundary of the rule rather than an
        // afterthought: the old check would have refused this whenever anything required was
        // missing, over a request that changed not one thing.
        var schema = SchemaOf(Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]));

        Assert.Empty(PropertyValidator.ValidateWrite(WriteOf("""{"title":"Notes"}""", "{}"), schema));
    }

    [Fact]
    public void A_create_owes_no_required_value_at_all()
    {
        // A required property is a statement about a finished item rather than about a first
        // keystroke. Demanding them here would mean nothing could be created inside a container
        // that requires anything.
        var schema = SchemaOf(
            Property("status", PropertyType.Select, "Status", required: true, options: ["Todo"]),
            Property("due", PropertyType.Date, "Due date"));

        Assert.Empty(PropertyValidator.ValidateSupplied(null, schema));
        Assert.Empty(PropertyValidator.ValidateSupplied("""{"title":"Notes"}""", schema));
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

        // All four keys are named by the write, so all four are its business: three hold values
        // that do not fit, and the fourth is being cleared while required.
        var violations = PropertyValidator.ValidateWrite(
            WriteOf(
                """{"owner":"Ada"}""",
                """{"status":"Shipped","due":"yesterday","estimate":"three","owner":null}"""),
            schema);

        string[] expected = ["status", "due", "estimate", "owner"];
        Assert.Equal(expected, violations.Select(violation => violation.Key).ToArray());
    }

    [Fact]
    public void Violations_come_back_in_the_order_the_schema_declares_them()
    {
        // Not in the order the change document happens to list them: the schema is the order a
        // person authored and the order a form draws, so a list of problems that followed the
        // request body would jump around between one write and the next.
        var schema = SchemaOf(
            Property("status", PropertyType.Select, "Status", options: ["Todo"]),
            Property("estimate", PropertyType.Number, "Estimate"));

        var violations = PropertyValidator.ValidateWrite(
            WriteOf(null, """{"estimate":"three","status":"Shipped"}"""),
            schema);

        string[] expected = ["status", "estimate"];
        Assert.Equal(expected, violations.Select(violation => violation.Key).ToArray());
    }

    [Fact]
    public void A_violation_names_the_property_by_its_label_rather_than_its_key()
    {
        // The reason goes in a problem document and from there onto a form. "Due date must be a
        // date" is actionable; "due_at_utc must be a date" is a leak of the storage key.
        var schema = SchemaOf(Property("due_at", PropertyType.Date, "Due date"));

        var violation = Assert.Single(PropertyValidator.ValidateSupplied("""{"due_at":"2026-13-01"}""", schema));

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

    [Theory]
    [InlineData("\"https://images.example.test/cover.jpg\"")]
    [InlineData("\"http://images.example.test/cover\"")]
    [InlineData("\"https://images.example.test/render?id=7&w=800\"")]
    public void Image_accepts_an_address_a_browser_can_fetch(string value)
    {
        // The third one has no file extension on purpose. Most image hosts serve from a path that
        // ends in an identifier, and refusing those would refuse addresses that work - an extension
        // is not a promise about what comes back, and this build never fetches it to find out.
        AssertAccepted(PropertyType.Image, value);
    }

    [Theory]
    [InlineData("\"images.example.test/cover.jpg\"")]
    [InlineData("\"/uploads/cover.jpg\"")]
    [InlineData("\"ftp://images.example.test/cover.jpg\"")]
    [InlineData("42")]
    [InlineData("true")]
    public void Image_refuses_an_address_that_is_relative_or_off_the_web(string value) =>
        AssertRefused(
            PropertyType.Image,
            value,
            "Field must be a link to an image, over http or https.");

    [Theory]
    [InlineData("\"javascript:alert(1)\"")]
    [InlineData("\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\"")]
    public void Image_refuses_a_scheme_that_would_be_fetched_or_inlined_by_the_render(string value)
    {
        // Stricter in consequence than the link type even though the rule is the same: nobody
        // clicks a cover. It goes into an img src and the browser fetches it unprompted, so a
        // scheme that gets through here is a scheme that runs without anybody choosing it.
        AssertRefused(
            PropertyType.Image,
            value,
            "Field must be a link to an image, over http or https.");
    }

    [Theory]
    [InlineData("\"2026-03-17\"")]
    [InlineData("\"1999-12-31\"")]
    public void Due_and_start_dates_accept_exactly_what_a_date_accepts(string value)
    {
        // The task types refine meaning, never representation: `left(value, 10)` comparisons and
        // the calendar's day bucketing must keep working on them unchanged.
        AssertAccepted(PropertyType.DueDate, value);
        AssertAccepted(PropertyType.StartDate, value);
    }

    [Theory]
    [InlineData("\"2026-03-17T09:00:00Z\"")]
    [InlineData("\"17/03/2026\"")]
    [InlineData("42")]
    public void Due_and_start_dates_refuse_what_a_date_refuses(string value)
    {
        AssertRefused(PropertyType.DueDate, value, "Field must be a date, as yyyy-MM-dd.");
        AssertRefused(PropertyType.StartDate, value, "Field must be a date, as yyyy-MM-dd.");
    }

    [Theory]
    [InlineData("true")]
    [InlineData("false")]
    public void Completion_accepts_a_JSON_boolean(string value) =>
        AssertAccepted(PropertyType.Completion, value);

    [Theory]
    [InlineData("\"true\"")]
    [InlineData("1")]
    [InlineData("\"done\"")]
    public void Completion_refuses_the_usual_stand_ins_for_a_boolean(string value) =>
        AssertRefused(PropertyType.Completion, value, "Field must be true or false.");

    [Theory]
    [InlineData("1")]
    [InlineData("2")]
    [InlineData("4")]
    public void Priority_accepts_the_closed_scale(string value) =>
        AssertAccepted(PropertyType.Priority, value);

    [Theory]
    [InlineData("0")]
    [InlineData("5")]
    [InlineData("1.5")]
    [InlineData("\"1\"")]
    [InlineData("\"high\"")]
    public void Priority_refuses_what_is_off_or_beside_the_scale(string value) =>
        AssertRefused(
            PropertyType.Priority,
            value,
            "Field must be a whole number from 1 (most urgent) to 4.");

    [Theory]
    [InlineData("0")]
    [InlineData("2.5")]
    [InlineData("40")]
    public void Estimate_accepts_a_non_negative_number(string value) =>
        AssertAccepted(PropertyType.Estimate, value);

    [Theory]
    [InlineData("-1")]
    [InlineData("\"3\"")]
    [InlineData("true")]
    public void Estimate_refuses_a_negative_or_non_number(string value) =>
        AssertRefused(PropertyType.Estimate, value, "Field must be a number of zero or more.");

    [Fact]
    public void Every_type_this_build_defines_refuses_a_value_of_the_wrong_shape()
    {
        // The net under the per-type cases above, and the reason the validator's fall-through arm
        // throws instead of returning null. An enum member with no arm of its own used to be
        // *accepted* - any JSON at all, unchecked, for a type nothing had taught the validator
        // about - and nothing on the accept path would ever have said so. A JSON object is the one
        // shape no type wants: not text, not a number, not a bool, not an array of options.
        var wrong = new JsonObject { ["not"] = "a value" }.ToJsonString();

        foreach (var type in Enum.GetValues<PropertyType>())
        {
            var schema = SchemaOf(Property("field", type, "Field"));

            Assert.Single(PropertyValidator.ValidateSupplied($$"""{"field":{{wrong}}}""", schema));
        }
    }

    [Fact]
    public void A_type_the_enum_does_not_define_is_a_bug_rather_than_an_accepted_value()
    {
        // The asymmetry that matters: unrecognised *text* is a fact about stored data and drops the
        // property, but an undefined enum member is a fact about this process. Silently accepting
        // its values is how an unvalidated string reaches an img src.
        var schema = SchemaOf(Property("field", (PropertyType)99, "Field"));

        Assert.Throws<ArgumentOutOfRangeException>(
            () => PropertyValidator.ValidateSupplied("""{"field":"anything at all"}""", schema));
    }

    [Fact]
    public void Select_accepts_a_value_the_property_declared()
    {
        var schema = SchemaOf(Property("field", PropertyType.Select, "Field", options: ["Todo", "Done"]));

        Assert.Empty(PropertyValidator.ValidateSupplied("""{"field":"Done"}""", schema));
    }

    [Theory]
    [InlineData("\"Shipped\"", "Field does not offer 'Shipped'.")]
    [InlineData("\"done\"", "Field does not offer 'done'.")]
    [InlineData("[\"Done\"]", "Field must be one of its options.")]
    [InlineData("7", "Field must be one of its options.")]
    public void Select_refuses_a_value_the_property_never_declared(string value, string reason)
    {
        var schema = SchemaOf(Property("field", PropertyType.Select, "Field", options: ["Todo", "Done"]));

        var violation = Assert.Single(PropertyValidator.ValidateSupplied($$"""{"field":{{value}}}""", schema));

        Assert.Equal(reason, violation.Reason);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[\"Todo\"]")]
    [InlineData("[\"Todo\",\"Done\"]")]
    public void A_multi_select_accepts_any_number_of_declared_values(string value)
    {
        var schema = SchemaOf(Property("field", PropertyType.MultiSelect, "Field", options: ["Todo", "Done"]));

        Assert.Empty(PropertyValidator.ValidateSupplied($$"""{"field":{{value}}}""", schema));
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

        var violation = Assert.Single(PropertyValidator.ValidateSupplied($$"""{"field":{{value}}}""", schema));

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
        var violation = Assert.Single(PropertyValidator.ValidateSupplied(properties, PropertySchema.Empty));

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
        var violation = Assert.Single(PropertyValidator.ValidateSupplied(properties, PropertySchema.Empty));

        Assert.Equal(string.Empty, violation.Key);
        Assert.Equal("The properties are not valid JSON.", violation.Reason);
    }

    [Fact]
    public void A_bag_at_exactly_the_ceiling_is_accepted()
    {
        var bag = BagOfSize(PropertyValidator.MaximumBytes, 'a');

        Assert.Equal(PropertyValidator.MaximumBytes, Encoding.UTF8.GetByteCount(bag));
        Assert.Empty(PropertyValidator.ValidateSupplied(bag, PropertySchema.Empty));
    }

    [Fact]
    public void A_bag_over_the_ceiling_is_refused_before_anything_else_is_looked_at()
    {
        // Checked here as well as by the column so an oversized bag is a problem document naming
        // the limit, rather than a constraint violation arriving as a 500. It is also the reason
        // the size check comes first: a bag too large to store is not worth parsing.
        //
        // The schema declares the bag's own "title" as a number, which the oversized bag holds as
        // text. That is a second, live violation - so Assert.Single is what proves the size check
        // returned early rather than merely running first. Declaring some other property required
        // would not: required-ness is enforced only on keys a write names, so it would be silently
        // inert here and the assertion would pass against a method that had stopped short-circuiting.
        var bag = BagOfSize(PropertyValidator.MaximumBytes + 1, 'a');
        var schema = SchemaOf(Property("title", PropertyType.Number, "Title"));

        var violation = Assert.Single(PropertyValidator.ValidateSupplied(bag, schema));

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
        Assert.Single(PropertyValidator.ValidateSupplied(bag, PropertySchema.Empty));
    }

    private static void AssertAccepted(PropertyType type, string value)
    {
        var schema = SchemaOf(Property("field", type, "Field"));

        Assert.Empty(PropertyValidator.ValidateSupplied($$"""{"field":{{value}}}""", schema));
    }

    private static void AssertRefused(PropertyType type, string value, string reason)
    {
        var schema = SchemaOf(Property("field", type, "Field"));

        var violation = Assert.Single(PropertyValidator.ValidateSupplied($$"""{"field":{{value}}}""", schema));

        Assert.Equal("field", violation.Key);
        Assert.Equal(reason, violation.Reason);
    }

    /// <summary>
    /// A write, built the way the request path builds one.
    /// </summary>
    /// <remarks>
    /// Through the real merge rather than by hand-pairing a bag with a key list. That pairing is
    /// what the rule turns on - which keys were named, against what the bag ended up as - and a
    /// test that assembled the two itself could assert a combination the merge cannot produce.
    /// </remarks>
    private static PropertyWrite WriteOf(string? stored, string changes)
    {
        var write = ItemProperties.Merge(stored, changes);

        Assert.NotNull(write);
        return write.Value;
    }

    /// <summary>A syntactically valid bag whose text is exactly <paramref name="length"/> characters.</summary>
    private static string BagOfSize(int length, char filler)
    {
        const string opening = "{\"title\":\"";
        const string closing = "\"}";

        return string.Concat(
            opening,
            new string(filler, length - opening.Length - closing.Length),
            closing);
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

        Assert.Empty(PropertyValidator.ValidateSupplied($$"""{"at":"{{text}}"}""", schema));
    }

    [Fact]
    public void The_same_wall_time_carries_a_different_offset_on_either_side_of_a_clock_change()
    {
        // Both are 09:00 in London, and they are an hour apart as instants. This is the whole
        // reason the zone is stored rather than only the moment: keeping the instant alone would
        // turn a 09:00 standup into a 10:00 one the day the clocks went forward.
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        Assert.Empty(
            PropertyValidator.ValidateSupplied("""{"at":"2026-03-17T09:00:00+00:00[Europe/London]"}""", schema));
        Assert.Empty(
            PropertyValidator.ValidateSupplied("""{"at":"2026-07-17T09:00:00+01:00[Europe/London]"}""", schema));
    }

    [Fact]
    public void An_offset_the_zone_was_not_using_is_refused()
    {
        // London is on +01:00 in July. A value claiming +00:00 renders as one time if the offset is
        // believed and another if the zone is, and there is no way to tell which was meant.
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        var violations =
            PropertyValidator.ValidateSupplied("""{"at":"2026-07-17T09:00:00+00:00[Europe/London]"}""", schema);

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

        Assert.Single(PropertyValidator.ValidateSupplied($$"""{"at":"{{text}}"}""", schema));
    }

    [Fact]
    public void A_zone_this_build_does_not_know_is_refused_by_name()
    {
        var schema = SchemaOf(Property("at", PropertyType.Timestamp, "At"));

        var violations =
            PropertyValidator.ValidateSupplied("""{"at":"2026-03-17T09:00:00+00:00[Middle/Earth]"}""", schema);

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
            PropertyValidator.ValidateSupplied("""{"due":"2026-03-17T09:00:00+00:00[Europe/London]"}""", schema));
    }
}
