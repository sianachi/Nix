using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The property type names are declared once, and no comment in the API writes the list out again.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a source scan.</b> The list that went stale was an XML comment on a contract record, and
/// a comment is not observable at runtime - there is nothing to read back off the built application
/// or off <c>backend/openapi/nix-api.json</c>. Where a published sentence enumerates a set it
/// should be generated from that set, and
/// <see cref="Nix.Tests.Features.Contracts.PublishedViewKindDescriptionTests"/> is what holds that
/// for the sentences that are published. Where an unpublished one enumerates a set, the only fix
/// that holds is not to write it, and the only thing that can check that is the source.
/// </para>
/// <para>
/// <b>What counts as a repetition: two or more of the names, on one comment line, joined the way a
/// list is joined</b> - by commas, <c>or</c>, or <c>and</c>. Markup is stripped first, so the same
/// run is recognised whether it is written <c>&lt;c&gt;date&lt;/c&gt;, &lt;c&gt;timestamp&lt;/c&gt;</c>,
/// <c>'date' or 'timestamp'</c>, or as the bare <c>date, timestamp</c> that most people reach for.
/// Requiring the list shape rather than merely counting names is what keeps ordinary prose out of
/// the results: <c>text</c>, <c>number</c>, <c>date</c> and <c>url</c> are common English words, and
/// a comment mentioning two of them in different sentences is not a list.
/// </para>
/// <para>
/// <b>Only comment lines are scanned, and only lowercase names match.</b> Both boundaries are
/// deliberate. Names in code are where the vocabulary legitimately has to be written out: the
/// <c>switch</c> arms in <see cref="PropertyTypes"/> that declare it, the Postgres column types in
/// the generated migrations, and hand-written SQL, where <c>IN ('date','timestamp')</c> is a
/// correct calendar query and not a copy of anything. A guard that fired on correct code would be
/// contorted around or deleted, so it does not look there. Matching case-sensitively then separates
/// naming the stored vocabulary from referring to an enum member: <c>&lt;see cref="Date"/&gt;</c> is
/// a cross-reference and stays a cross-reference.
/// </para>
/// <para>
/// The vocabulary is read from the enum rather than typed out, so a type added tomorrow is scanned
/// for from the moment it exists. That a type added tomorrow also has a name at all is held by
/// <c>Every_type_this_build_defines_survives_being_written_and_read_back</c> in
/// <see cref="PropertyTypeTests"/>, which fails when a member reaches the enum without reaching
/// <see cref="PropertyTypes.ToText"/>. This file defers to it rather than competing to report the
/// same gap worse: a member with no name is simply left out of the scan.
/// </para>
/// </remarks>
public sealed class PropertyTypeVocabularyTests
{
    private static List<string>? _vocabulary;
    private static Regex? _enumeration;

    /// <summary>Every stored name this build defines, taken from the enum, not typed out.</summary>
    /// <remarks>
    /// Built on first use rather than in a field initialiser. A static initialiser that throws
    /// takes every test in the class down with a <c>TypeInitializationException</c>, which buries
    /// the one or two failures that would have said what actually broke.
    /// </remarks>
    private static List<string> Vocabulary => _vocabulary ??= BuildVocabulary();

    [Fact]
    public void No_file_in_the_api_repeats_the_list_of_property_type_names()
    {
        var offenders = new StringBuilder();

        foreach (var file in ApiSourceFiles())
        {
            var repeated = NamesEnumeratedIn(File.ReadAllText(file));

            if (repeated.Count == 0)
            {
                continue;
            }

            offenders
                .Append(CultureInfo.InvariantCulture, $"{Path.GetRelativePath(RepositoryRoot(), file)}: ")
                .AppendJoin(", ", repeated)
                .AppendLine();
        }

        Assert.True(
            offenders.Length == 0,
            "These comments write out the property type vocabulary, which is declared in "
                + "Domain/Properties/PropertyType.cs and goes stale everywhere else it is copied. "
                + "Refer to PropertyType instead of listing its members:"
                + Environment.NewLine
                + offenders);
    }

    [Fact]
    public void A_list_of_names_is_recognised_however_a_comment_writes_it()
    {
        // The detector is the whole guard, so it is checked against every shape the codebase
        // writes prose in - including the bare one, which is how most people write a list.
        Assert.Equal(2, NamesEnumeratedIn("/// One of <c>select</c>, <c>checkbox</c>.").Count);
        Assert.Equal(2, NamesEnumeratedIn("/// A type is one of 'select' or 'checkbox'.").Count);
        Assert.Equal(3, NamesEnumeratedIn("// Type is one of: text, number, select").Count);
        Assert.Equal(2, NamesEnumeratedIn("/// Either date and timestamp belong on a calendar.").Count);
    }

    [Fact]
    public void Naming_one_type_is_a_reference_rather_than_a_list()
    {
        Assert.Empty(NamesEnumeratedIn("/// The <c>select</c> types draw from a declared list."));

        // Two names in one comment are not a list unless they are joined like one. These words are
        // ordinary English, and a guard that flagged them would fire on comments about anything.
        Assert.Empty(NamesEnumeratedIn("/// The number of items, taken from the text of the label."));

        // A cross-reference to a member is the form this guard exists to encourage, not to punish.
        Assert.Empty(NamesEnumeratedIn("""/// Distinct from <see cref="Date"/> rather than replacing it."""));
    }

    [Fact]
    public void Declaring_the_vocabulary_in_code_is_not_repeating_it()
    {
        // This is what PropertyTypes itself looks like, and what hand-written SQL filtering on a
        // property type has to look like. If the scan flagged either, the guard would be asking
        // correct code to be written some other way.
        var declaration = """
            case "select": type = PropertyType.Select; return true;
            case "checkbox": type = PropertyType.Checkbox; return true;
            """;

        Assert.Empty(NamesEnumeratedIn(declaration));
        Assert.Empty(NamesEnumeratedIn("WHERE p.type IN ('date','timestamp')"));
    }

    [Fact]
    public void The_scan_reaches_the_contract_that_carried_the_stale_list()
    {
        // A scan that found nothing because it was pointed at the wrong directory would pass the
        // guard above in silence. Anchor it to the file the rot was found in.
        var expected = Path.Combine(
            RepositoryRoot(),
            "backend",
            "src",
            "Nix.Api",
            "Features",
            "Properties",
            "PropertyContracts.cs");

        Assert.True(
            ApiSourceFiles().Contains(expected, StringComparer.Ordinal),
            $"{expected} is not being scanned. If PropertyContracts.cs was legitimately renamed or "
                + "moved, repoint this anchor at its new path; the anchor exists so that a scan "
                + "which quietly stopped reaching the API fails here instead of passing empty.");
    }

    [Fact]
    public void The_declaration_is_allowed_to_name_its_own_members()
    {
        // The mirror of the anchor above. PropertyType.cs is the one file entitled to write the
        // vocabulary out, and explaining why two types are distinct necessarily names both.
        var declaration = Path.Combine(
            RepositoryRoot(),
            "backend",
            "src",
            "Nix.Api",
            "Domain",
            "Properties",
            "PropertyType.cs");

        Assert.True(File.Exists(declaration), $"{declaration} is where the vocabulary is declared.");
        Assert.DoesNotContain(declaration, ApiSourceFiles(), StringComparer.Ordinal);
    }

    [Fact]
    public void No_two_types_share_a_stored_name()
    {
        // Two members mapping to one name passes every round-trip sweep in PropertyTypeTests,
        // because TryParse returns the first of them and the round trip closes on that one. The
        // second member would then be unreachable from stored data, and silently so.
        Assert.Equal(Vocabulary.Count, Vocabulary.Distinct(StringComparer.Ordinal).Count());
    }

    /// <summary>The names written as a list on a comment line.</summary>
    /// <param name="source">The source text.</param>
    /// <returns>The distinct names taking part in a list, in vocabulary order.</returns>
    private static List<string> NamesEnumeratedIn(string source)
    {
        var found = new List<string>();

        foreach (var line in source.Split('\n'))
        {
            if (!line.TrimStart().StartsWith("//", StringComparison.Ordinal))
            {
                continue;
            }

            // Markup off first, so one pattern recognises every way a list gets written.
            var prose = line
                .Replace("<c>", string.Empty, StringComparison.Ordinal)
                .Replace("</c>", string.Empty, StringComparison.Ordinal)
                .Replace("'", string.Empty, StringComparison.Ordinal);

            foreach (var run in Enumeration().Matches(prose).Cast<Match>())
            {
                foreach (var name in run.Groups["name"].Captures.Cast<Capture>())
                {
                    if (!found.Contains(name.Value, StringComparer.Ordinal))
                    {
                        found.Add(name.Value);
                    }
                }
            }
        }

        // Vocabulary order, so a failure message reads the same way twice.
        return Vocabulary.Where(name => found.Contains(name, StringComparer.Ordinal)).ToList();
    }

    /// <summary>Two or more vocabulary names joined the way a list joins them.</summary>
    /// <returns>The pattern, built once from the enum.</returns>
    private static Regex Enumeration()
    {
        if (_enumeration is not null)
        {
            return _enumeration;
        }

        // One capturing group, repeated, so the names in a run come straight off the match.
        var name = $@"(?<name>\b(?:{string.Join("|", Vocabulary.Select(Regex.Escape))})\b)";
        var separator = @"(?:\s*,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+)";

        _enumeration = new Regex(
            $"{name}(?:{separator}{name})+",
            RegexOptions.None,
            TimeSpan.FromSeconds(1));

        return _enumeration;
    }

    /// <summary>Every hand-written source file in the API project, bar the declaration itself.</summary>
    /// <returns>Absolute paths.</returns>
    /// <remarks>
    /// Build output and the generated migrations are skipped: neither is somewhere anybody could
    /// fix a finding, and the migrations name Postgres column types that collide with the
    /// vocabulary by coincidence. <c>Domain/Properties/PropertyType.cs</c> is skipped because it is
    /// the declaration - telling the file that defines the vocabulary to refer to the file that
    /// defines the vocabulary is advice that closes a circle, and its remarks have to name two
    /// types side by side to say why those two are distinct.
    /// </remarks>
    private static List<string> ApiSourceFiles()
    {
        var api = Path.Combine(RepositoryRoot(), "backend", "src", "Nix.Api");
        var declaration = Path.Combine("Domain", "Properties", "PropertyType.cs");
        var files = new List<string>();

        foreach (var file in Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(api, file);

            if (relative.StartsWith("obj" + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                || relative.StartsWith("bin" + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                || relative.Contains("Migrations" + Path.DirectorySeparatorChar + "Generated", StringComparison.Ordinal)
                || string.Equals(relative, declaration, StringComparison.Ordinal))
            {
                continue;
            }

            files.Add(file);
        }

        return files;
    }

    /// <summary>Finds the repository root by the solution file that sits in it.</summary>
    /// <returns>The absolute path of the root.</returns>
    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
        {
            directory = directory.Parent;
        }

        // Failing loudly rather than skipping: a guard that quietly stops running is worse than no
        // guard, because the codebase goes on believing it is held.
        Assert.True(
            directory is not null,
            $"No Nix.slnx above {AppContext.BaseDirectory}, so the API source cannot be scanned.");

        return directory!.FullName;
    }

    /// <summary>Reads the stored names off the enum, skipping any member that has not got one.</summary>
    /// <returns>The names, in enum order.</returns>
    private static List<string> BuildVocabulary()
    {
        var names = new List<string>();

        foreach (var type in Enum.GetValues<PropertyType>())
        {
            try
            {
                names.Add(PropertyTypes.ToText(type));
            }
            catch (ArgumentOutOfRangeException)
            {
                // A member with no stored name is PropertyTypeTests' finding to report, and it
                // reports it far better than a scan collapsing on the way to the file system.
            }
        }

        return names;
    }
}
