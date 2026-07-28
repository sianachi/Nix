namespace Nix.Messaging;

/// <summary>
/// A request that changes state, carrying the type its handler produces on success.
/// </summary>
/// <typeparam name="TValue">
/// What the handler yields when it succeeds. The handler returns
/// <c>Result&lt;TValue&gt;</c> rather than <typeparamref name="TValue"/> directly.
/// </typeparam>
/// <remarks>
/// <para>
/// <b>Failure is not optional on a command.</b> Every write in Nix can fail in a way the caller is
/// expected to handle - the workspace is not visible, the parent does not exist, the properties do
/// not match the schema - so <c>Result</c> is baked into the handler's return type rather than
/// left to each command to remember. A command that genuinely cannot fail does not need this
/// interface; it is a query.
/// </para>
/// <para>
/// The type argument is carried here rather than declared on the handler alone so that
/// <see cref="NixDispatcher"/> can constrain the two together and the compiler can reject a
/// command sent to the wrong handler.
/// </para>
/// </remarks>
#pragma warning disable CA1040 // Justification: a dispatch marker, not an empty contract. It carries
// TValue, which is what binds a command to its handler's result type in NixDispatcher's constraint.
// Adding a member would put something on every command that no command needs.
public interface ICommand<TValue>;
#pragma warning restore CA1040
