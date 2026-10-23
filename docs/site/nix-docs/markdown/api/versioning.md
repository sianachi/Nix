# Versioning

This is what the server does today. It is not a support window.

## What is versioned

- Workspace and item routes are under `/api/v1`.
- Token exchange is `POST /public/v1/auth/token`. Signing keys are `GET /public/v1/auth/jwks`. Public forms are under `/public/v1/forms/`.
- Liveness is `GET /healthz`, outside the version prefix, so a process probe does not move when the API prefix does.
- `GET /api/v1/health/status` reports the running build's version string. That string identifies the build. It is not the API's compatibility version.

The OpenAPI document sets `info.version` to `1.0.0`. The application does not set that field; `1.0.0` is the document generator's default. Do not treat it as a promise that the document will stay compatible for a numbered lifetime.

## What the project treats as the contract

`backend/openapi/nix-api.json` is the contract of record. CI rebuilds it from the endpoints and fails if the committed file moved. The reference in this guide is generated from that file and checked the same way.

`code` values are how clients tell failures apart. The server's own rule is that a code is not renamed without a review of the OpenAPI change. The document still declares a 501 on some item routes that are implemented; removing a declared response is a contract change of its own, so those 501s remain until a change removes them on purpose.

Internal routes under `/internal` are absent from the public document. They are for services inside a deployment.

## What is not promised

The repository does not define:

- how long a field or route under `/api/v1` will keep its current shape;
- a deprecation header, a sunset date, or a period when two versions run together;
- a `/api/v2`;
- a rate-limit number that will stay at today's default (the keys are configuration);
- a price for hosted API use.

Those are open product decisions. Until they are decided, clients should treat the current `/api/v1` document as the behaviour of this build, and should branch on `code` rather than on prose in `detail`.

A route that edits a note body is not in `/api/v1` yet. Adding one will be a new operation. It does not change the meaning of `PATCH /api/v1/items/{itemId}`, which renames.

## Properties

- title: Versioning
