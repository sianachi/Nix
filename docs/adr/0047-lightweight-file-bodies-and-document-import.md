# ADR-0047: Lightweight file bodies and document import

## Status

Accepted, 2026-08-31. Media responsibility assignments are superseded by
[ADR-0048](0048-rabbitmq-and-unified-go-workers.md).

Implementation note, 5 September 2026: the temporary opaque publication path bypasses the
inspection described below, and the web now includes PDF/image previews. These are recorded
implementation discrepancies, not retroactive changes to this decision. See
[the documentation audit](../README.md#open-architecture-discrepancy).

## Context

Nix needs durable image and arbitrary-file children plus editable imports from DOCX, PDF and UTF-8 text. Core must remain the authorization and RLS authority, Media must never receive database credentials, and file bytes must never pass through Core. A resident antivirus daemon would consume more memory than this deployment can justify and cannot make an uploaded binary safe to execute.

## Decision

- `file` is one open item body kind. Core stores immutable version metadata and the current-version pointer; private object storage stores bytes.
- Core owns authorization, quota, idempotent upload state, version publication and tenant isolation. Media owns signed upload capabilities, streaming SHA-256 calculation, bounded header inspection and authorized delivery. Go owns document parsing. Collaboration owns imported editable note bodies.
- Uploads are private and limited to 100 MiB. Declared MIME types and extensions are advisory; Media derives the stored type from bounded magic/header inspection.
- Nix performs no malware scan and never claims an attachment is safe. Opaque files are never executed or unpacked and are always delivered as attachments with `nosniff`.
- Static PNG, JPEG and supported WebP/AVIF images may render inline only below 10 MiB and 40 megapixels. Active, animated, malformed or oversized image formats remain download-only. Originals are never transcoded.
- DOCX, PDF and UTF-8 TXT imports create editable notes and retain the original as a child file. Supported DOCX raster media is extracted as additional child files. PDF OCR is explicitly unavailable.
- A failed replacement never displaces the current cleanly published version. Temporary objects expire and incomplete metadata never appears in normal item reads.

## Consequences

There is no high-memory signature database or scanner daemon. The residual malware-distribution risk is handled honestly through private authorization, opaque delivery, non-execution and UI wording rather than a false safety claim. Content disarm, OCR, archive browsing, thumbnails, transcoding and general binary indexing remain separate future decisions.
