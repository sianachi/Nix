# Naming: shortlist and recommendation

Status: proposal for the owner. No trademark search, domain availability check or legal clearance
was performed; nothing here implies the names are free to use. The public identity is the owner's
decision and is not changed by this document.

## Why the question exists

"Nix" collides with the Nix package manager and NixOS (nixos.org), a large, long-established
project whose `.nix` file extension this product also uses for its archive format. Searches,
package names, Homebrew taps, and `nix` on a command line already mean the other project. The
collision costs discoverability and causes real confusion in error messages ("a .nix file could not
be parsed" reads as a Nix language error).

## Shortlist

| Name | Rationale | Risks noted (not checked) |
| --- | --- | --- |
| Osi | Short, personal; matches the `osinachi` slug already in use; two-letter CLI (`osi`). | Common given name; generic search results. |
| Lumen | "A unit of light" fits notes, pages and the life-OS framing; reads well as `lumen.` sites. | Widely used in software (Laravel Lumen, Lumen Technologies). |
| Tessel | A tile in a mosaic: pages, views and groups assembling into one picture. | Formerly a hardware board brand (Tessel 2). |
| Pennon | A small flag you carry; personal, distinctive, pronounceable. | Obscure word; spelling questions. |
| Quillon | Cross-guard of a sword, "quill" inside it suggests writing; distinctive. | Invented-sounding; needs explaining. |

## Recommendation

Lumen or Tessel for a product name, with the CLI keeping a short lowercase binary (`lumen`,
`tessel`). Recommend Tessel first: fewer established software products share it, it is easy to say
and spell, and the mosaic image matches how Nix composes items, views and workspace groups. Confirm
availability before any public use.

## What a rename would and would not touch

See `rename-impact.md`. The `.nix` archive suffix, storage keys and database names are deliberately
not renamed in v0.1 even if the product name changes.
