using Nix.Domain.Files;

namespace Nix.Tests.Domain.Files;

/// <summary>
/// <see cref="FileNaming.RenamedFileName"/>: the extension rule a file body's stored name follows
/// when the item it belongs to is renamed.
/// </summary>
public sealed class FileNamingTests
{
    [Fact]
    public void A_title_with_no_extension_gets_the_current_one_appended()
    {
        Assert.Equal("report.pdf", FileNaming.RenamedFileName("report", "old.pdf"));
    }

    [Fact]
    public void A_title_already_carrying_the_current_extension_is_used_as_is()
    {
        Assert.Equal("report.pdf", FileNaming.RenamedFileName("report.pdf", "old.pdf"));
    }

    [Fact]
    public void The_extension_match_is_case_insensitive()
    {
        Assert.Equal("report.PDF", FileNaming.RenamedFileName("report.PDF", "old.pdf"));
    }

    [Fact]
    public void A_title_carrying_a_different_extension_still_gets_the_current_one_appended()
    {
        // The title's own trailing dots are just text here - only the stored file's extension is
        // authoritative, since that is what the bytes actually are.
        Assert.Equal("report.docx.pdf", FileNaming.RenamedFileName("report.docx", "old.pdf"));
    }

    [Fact]
    public void A_current_file_name_with_no_extension_leaves_the_title_untouched()
    {
        Assert.Equal("report", FileNaming.RenamedFileName("report", "old"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void A_title_blank_after_trimming_leaves_the_file_name_alone(string title)
    {
        Assert.Null(FileNaming.RenamedFileName(title, "old.pdf"));
    }

    [Fact]
    public void Surrounding_whitespace_in_the_title_is_trimmed_before_the_extension_check()
    {
        Assert.Equal("report.pdf", FileNaming.RenamedFileName("  report.pdf  ", "old.pdf"));
    }
}
