using System.Diagnostics.CodeAnalysis;

namespace Nix.Domain.Primitives;

/// <summary>
/// The outcome of an operation that can fail in ways the caller is expected to handle: either a
/// value, or a <see cref="NixError"/> explaining why there is none.
/// </summary>
/// <typeparam name="TValue">The type produced on success.</typeparam>
/// <remarks>
/// <para>
/// A struct, so the common path allocates nothing. Use cases return these by the thousand on a
/// request path and none of them should cost a heap object to say "yes".
/// </para>
/// <para>
/// Constructed through the non-generic <see cref="Result"/> factory rather than through static
/// members here, which lets <c>Result.Success(item)</c> infer its type argument and keeps the
/// analyzers happy about static members on generic types.
/// </para>
/// <para>
/// There is deliberately no implicit conversion from <typeparamref name="TValue"/>. It reads
/// nicely and it hides the one thing worth seeing at a glance - where a result is constructed, and
/// therefore where a failure could have been returned instead.
/// </para>
/// </remarks>
public readonly record struct Result<TValue>
{
    private readonly TValue? _value;

    internal Result(TValue value)
    {
        _value = value;
        Error = NixError.None;
        IsSuccess = true;
    }

    internal Result(NixError error)
    {
        if (!error.IsSet)
        {
            throw new ArgumentException(
                "A failed result must carry a real error. An empty code would reach the API as a "
                + "problem document a client cannot branch on.",
                nameof(error));
        }

        _value = default;
        Error = error;
        IsSuccess = false;
    }

    /// <summary>Gets a value indicating whether the operation produced a value.</summary>
    [MemberNotNullWhen(true, nameof(_value))]
    public bool IsSuccess { get; }

    /// <summary>Gets a value indicating whether the operation failed.</summary>
    public bool IsFailure => !IsSuccess;

    /// <summary>Gets the failure, or <see cref="NixError.None"/> on success.</summary>
    public NixError Error { get; }

    /// <summary>
    /// Gets the value.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// The result is a failure. Reading the value without checking is a bug in the caller rather
    /// than an expected outcome, so this throws instead of returning a default that would flow
    /// onwards as a null or a zero.
    /// </exception>
    public TValue Value => IsSuccess
        ? _value
        : throw new InvalidOperationException(
            $"Cannot read the value of a failed result. The error was '{Error.Code}': {Error.Message}");

    /// <summary>
    /// Reduces the result to a single value by handling both cases.
    /// </summary>
    /// <typeparam name="TOut">What both branches produce.</typeparam>
    /// <param name="onSuccess">Applied to the value.</param>
    /// <param name="onFailure">Applied to the error.</param>
    /// <returns>Whichever branch ran.</returns>
    /// <remarks>
    /// The endpoint layer's whole job: map a use case's outcome onto a response, with nowhere to
    /// forget the failure branch.
    /// </remarks>
    public TOut Match<TOut>(Func<TValue, TOut> onSuccess, Func<NixError, TOut> onFailure)
    {
        ArgumentNullException.ThrowIfNull(onSuccess);
        ArgumentNullException.ThrowIfNull(onFailure);

        return IsSuccess ? onSuccess(_value) : onFailure(Error);
    }
}

/// <summary>
/// Creates <see cref="Result{TValue}"/> values.
/// </summary>
/// <remarks>
/// Non-generic so <c>Result.Success(item)</c> infers its type argument at the call site, which is
/// where these are written most often.
/// </remarks>
public static class Result
{
    /// <summary>Creates a successful result.</summary>
    /// <typeparam name="TValue">The type produced.</typeparam>
    /// <param name="value">The value produced.</param>
    /// <returns>A successful result.</returns>
    public static Result<TValue> Success<TValue>(TValue value) => new(value);

    /// <summary>Creates a failed result.</summary>
    /// <typeparam name="TValue">The type the operation would have produced.</typeparam>
    /// <param name="error">Why the operation failed.</param>
    /// <returns>A failed result.</returns>
    public static Result<TValue> Failure<TValue>(NixError error) => new(error);

    /// <summary>Creates a failed result from a code and message.</summary>
    /// <typeparam name="TValue">The type the operation would have produced.</typeparam>
    /// <param name="code">The stable machine-readable code.</param>
    /// <param name="message">The human-readable explanation.</param>
    /// <returns>A failed result.</returns>
    public static Result<TValue> Failure<TValue>(string code, string message) =>
        new(new NixError(code, message));
}
