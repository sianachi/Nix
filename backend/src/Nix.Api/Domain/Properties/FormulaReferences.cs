using System.Collections.Immutable;

namespace Nix.Domain.Properties;

/// <summary>
/// The property keys a formula expression reads, and whether a set of formulas refers in a circle.
/// </summary>
/// <remarks>
/// <para>
/// <b>This reads references; it does not evaluate, and it is not a parser.</b> The formula engine
/// is <c>@nix/sheet</c> - one engine, shared by the editor and the collaboration service, which is
/// the property goal 2.1 is built to keep - so Core deliberately has no expression evaluator and
/// never gains one. What Core cannot delegate is the safety question: whether the schema somebody
/// just submitted refers to itself. A client can be wrong or absent, and a stored cycle would be
/// evaluated by every reader forever after.
/// </para>
/// <para>
/// <b>A reference is bracketed text, and that is the whole grammar this needs.</b>
/// <c>[estimate] * 1.2</c> reads <c>estimate</c>. The scan skips string literals, exactly as the
/// lexer does, so <c>"[not a reference]"</c> contributes nothing - without that, a formula with a
/// bracket in a caption could be refused as a cycle it never had. Everything else about the
/// expression - operators, precedence, whether the function exists - is the engine's business and
/// surfaces to the reader as <c>#PARSE!</c> or <c>#NAME?</c> where the value is drawn, which is the
/// honest place for it.
/// </para>
/// <para>
/// The counterpart is <c>formulaFieldNames</c> in <c>packages/sheet/src/properties.ts</c>, which
/// answers the same question by actually parsing. The two must agree on which text is a reference;
/// <c>FormulaReferenceTests</c> holds this side to the cases that matter.
/// </para>
/// </remarks>
public static class FormulaReferences
{
    /// <summary>
    /// The longest expression a schema may declare.
    /// </summary>
    /// <remarks>
    /// Matches <c>PROPERTY_FORMULA_LIMITS.maxLength</c> in <c>packages/sheet/src/properties.ts</c>.
    /// The two are the same bound written on both sides of the wire: Core refuses to store what the
    /// engine would answer <c>#LIMIT!</c> for, so nobody authors a property that can only ever
    /// report a limit.
    /// </remarks>
    public const int MaximumExpressionLength = 1_024;

    /// <summary>Reads the property keys an expression refers to, each once.</summary>
    /// <param name="expression">The expression, without a leading <c>=</c>.</param>
    /// <returns>The referenced keys, in the order they appear.</returns>
    public static ImmutableArray<string> Read(string? expression)
    {
        if (string.IsNullOrEmpty(expression))
        {
            return [];
        }

        var found = ImmutableArray.CreateBuilder<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < expression.Length; i++)
        {
            var character = expression[i];

            if (character == '"')
            {
                // Skipped whole, doubled quotes included, so a bracket inside a caption is text.
                // An unterminated literal runs to the end, which is also what the lexer does with
                // it before reporting the expression unparseable.
                i++;
                while (i < expression.Length)
                {
                    if (expression[i] == '"')
                    {
                        if (i + 1 < expression.Length && expression[i + 1] == '"')
                        {
                            i += 2;
                            continue;
                        }

                        break;
                    }

                    i++;
                }

                continue;
            }

            if (character != '[')
            {
                continue;
            }

            var close = expression.IndexOf(']', i + 1);
            if (close < 0)
            {
                // Unclosed: not a reference, and an expression the engine will refuse to parse.
                break;
            }

            var key = expression[(i + 1)..close].Trim();
            if (key.Length > 0 && seen.Add(key))
            {
                found.Add(key);
            }

            i = close;
        }

        return found.ToImmutable();
    }

    /// <summary>
    /// The first formula property that refers to itself, directly or through others.
    /// </summary>
    /// <param name="formulas">
    /// Each formula property's key and its expression. Non-formula properties are constants for the
    /// length of an evaluation and are not nodes of this graph, so they belong nowhere in it. The
    /// expression is non-null because a formula with no expression has already been refused by the
    /// time a cycle can be asked about - the invariant is in the type rather than re-derived here.
    /// </param>
    /// <returns>The key of a property on a cycle, or <see langword="null"/> when there is none.</returns>
    /// <remarks>
    /// Kahn's algorithm: whatever the queue cannot drain sits on a cycle. The key returned is the
    /// ordinally first one left, so the same schema always names the same property - a refusal that
    /// picked arbitrarily would give two people two different answers to one mistake.
    /// </remarks>
    public static string? FindCycle(IReadOnlyDictionary<string, string> formulas)
    {
        ArgumentNullException.ThrowIfNull(formulas);

        if (formulas.Count == 0)
        {
            return null;
        }

        var dependents = new Dictionary<string, List<string>>(formulas.Count, StringComparer.Ordinal);
        var indegree = new Dictionary<string, int>(formulas.Count, StringComparer.Ordinal);
        foreach (var key in formulas.Keys)
        {
            dependents[key] = [];
            indegree[key] = 0;
        }

        foreach (var (key, expression) in formulas)
        {
            var precedents = new HashSet<string>(StringComparer.Ordinal);
            foreach (var reference in Read(expression))
            {
                if (formulas.ContainsKey(reference))
                {
                    precedents.Add(reference);
                }
            }

            foreach (var precedent in precedents)
            {
                dependents[precedent].Add(key);
                indegree[key]++;
            }
        }

        var queue = new Queue<string>();
        foreach (var (key, degree) in indegree)
        {
            if (degree == 0)
            {
                queue.Enqueue(key);
            }
        }

        var settled = 0;
        while (queue.TryDequeue(out var key))
        {
            settled++;
            foreach (var dependent in dependents[key])
            {
                if (--indegree[dependent] == 0)
                {
                    queue.Enqueue(dependent);
                }
            }
        }

        if (settled == formulas.Count)
        {
            return null;
        }

        string? first = null;
        foreach (var (key, degree) in indegree)
        {
            if (degree > 0 && (first is null || string.CompareOrdinal(key, first) < 0))
            {
                first = key;
            }
        }

        return first;
    }
}
