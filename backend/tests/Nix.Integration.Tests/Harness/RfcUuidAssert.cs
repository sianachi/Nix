namespace Nix.Integration.Tests.Harness;

internal static class RfcUuidAssert
{
    private static readonly char[] RfcVariants = ['8', '9', 'a', 'b'];

    internal static void Version4(IEnumerable<Guid> values)
    {
        ArgumentNullException.ThrowIfNull(values);

        Assert.All(values, value =>
        {
            var text = value.ToString("D", System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal('4', text[14]);
            Assert.Contains(text[19], RfcVariants);
        });
    }
}
