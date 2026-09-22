using Nix.Domain.Finance;

namespace Nix.Tests.Domain.Finance;

public sealed class CsvStatementTests
{
    [Fact]
    public void A_signed_amount_export_is_read_by_its_headers()
    {
        var parse = CsvStatements.Parse("Date,Description,Amount,Balance\n21/09/2026,EXAMPLE SHOP,-12.40,1234.56\n22/09/2026,\"SALARY, ACME LTD\",4000.00,5234.56\n");

        Assert.Null(parse.Problem);
        Assert.Equal(2, parse.Readable);
        Assert.Equal(new DateOnly(2026, 9, 21), parse.Rows[0].Date);
        Assert.Equal(-12.40m, parse.Rows[0].Amount);
        Assert.Equal("EXAMPLE SHOP", parse.Rows[0].Description);
        Assert.Equal(4000m, parse.Rows[1].Amount);
        Assert.Equal("SALARY, ACME LTD", parse.Rows[1].Description);
    }

    [Fact]
    public void Money_in_and_money_out_columns_become_one_cash_effect()
    {
        var parse = CsvStatements.Parse("Transaction Date,Details,Money Out,Money In\n2026-09-01,Rent,900.00,\n2026-09-25,Salary,,\"4,000.00\"\n2026-09-26,Nothing,,\n");

        Assert.Null(parse.Problem);
        Assert.Equal(-900m, parse.Rows[0].Amount);
        Assert.Equal(4000m, parse.Rows[1].Amount);
        Assert.False(parse.Rows[2].IsReadable);
        Assert.Equal("The row moves no money.", parse.Rows[2].Problem);
    }

    [Fact]
    public void Symbols_parentheses_and_blank_lines_are_handled()
    {
        var parse = CsvStatements.Parse("date,memo,amount\r\n\r\n1 Sep 2026,Coffee,(3.20)\r\n02/09/2026,Refund,+£4.00\r\nnot a date,Broken,1.00\r\n");

        Assert.Null(parse.Problem);
        Assert.Equal(3, parse.Rows.Count);
        Assert.Equal(-3.20m, parse.Rows[0].Amount);
        Assert.Equal(4m, parse.Rows[1].Amount);
        Assert.False(parse.Rows[2].IsReadable);
        Assert.Equal(5, parse.Rows[2].Row);
    }

    [Fact]
    public void A_file_without_the_columns_is_refused_with_the_headers_it_had()
    {
        var parse = CsvStatements.Parse("Foo,Bar\n1,2\n");

        Assert.NotNull(parse.Problem);
        Assert.Contains("Foo, Bar", parse.Problem, StringComparison.Ordinal);
        Assert.Empty(parse.Rows);
    }

    [Fact]
    public void The_import_key_ignores_case_and_spacing_but_not_the_day_or_the_amount()
    {
        var account = Guid.NewGuid();
        var day = new DateOnly(2026, 9, 21);

        Assert.Equal(CsvStatements.ImportKey(account, day, -12.4m, "Example Shop 100"), CsvStatements.ImportKey(account, day, -12.40m, "  EXAMPLE  SHOP-100 "));
        Assert.NotEqual(CsvStatements.ImportKey(account, day, -12.4m, "Example shop"), CsvStatements.ImportKey(account, day.AddDays(1), -12.4m, "Example shop"));
        Assert.NotEqual(CsvStatements.ImportKey(account, day, -12.4m, "Example shop"), CsvStatements.ImportKey(account, day, -12.41m, "Example shop"));
        Assert.Equal(32, CsvStatements.ImportKey(account, day, -12.4m, "Example shop").Length);
    }
}
