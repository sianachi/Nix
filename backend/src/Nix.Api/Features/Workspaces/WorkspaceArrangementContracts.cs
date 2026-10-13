using Nix.Messaging;

namespace Nix.Features.Workspaces;

/// <summary>One named group of workspaces in a person's own arrangement.</summary>
/// <param name="Id">A client-chosen stable id, so renames keep the group's place.</param>
/// <param name="Name">What the switcher shows above the group.</param>
/// <param name="WorkspaceIds">The workspaces in it, in order. A workspace belongs to at most one group.</param>
public sealed record WorkspaceGroupDto(Guid Id, string Name, IReadOnlyList<Guid> WorkspaceIds);

/// <summary>The fields a caller may set. Used for both the read default and a write.</summary>
public sealed record WorkspaceArrangementInput(IReadOnlyList<WorkspaceGroupDto> Groups, IReadOnlyList<Guid> PinnedWorkspaceIds);

/// <summary>The saved arrangement and its concurrency version.</summary>
public sealed record WorkspaceArrangementResponse(long Revision, IReadOnlyList<WorkspaceGroupDto> Groups, IReadOnlyList<Guid> PinnedWorkspaceIds);

/// <summary>Replaces the owner's arrangement only at the version they edited.</summary>
public sealed record SaveWorkspaceArrangementRequest(long ExpectedRevision, WorkspaceArrangementInput Arrangement);

/// <summary>Reads the caller's own arrangement, empty when never saved.</summary>
public sealed record GetWorkspaceArrangement : IQuery<WorkspaceArrangementResponse>;

/// <summary>Replaces the caller's own arrangement using a compare-and-swap revision.</summary>
public sealed record SaveWorkspaceArrangement(long ExpectedRevision, WorkspaceArrangementInput Arrangement) : ICommand<WorkspaceArrangementResponse>;
