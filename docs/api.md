# Xal public website API

The Xal website publishes a small, public REST API for agents and developer tooling that need canonical product metadata. It is separate from the local coding harness and does not provide remote access to a user's terminal, files, sessions, plugins, or configured AI providers.

## Base URL and authentication

The production base URL is `https://xal.sh/api/v1`. The API is read-only and does not require an account, API key, or bearer token. Responses allow cross-origin reads and may be cached. Normal hosting-layer abuse protection still applies.

## Get product metadata

`GET /api/v1/product` returns the current Xal version, beta status, supported platforms and architectures, install command, high-level capabilities, and canonical links for documentation, source, support, policy, and machine-readable resources.

```sh
curl -sS \
  -H 'Accept: application/json' \
  https://xal.sh/api/v1/product
```

The endpoint also supports `HEAD` and answers CORS preflight requests with `OPTIONS`.

## Errors

API errors always use `application/json` and contain a stable `code`, a human-readable `message`, and a specific `resolution` hint.

```json
{
  "error": {
    "code": "api_route_not_found",
    "message": "No Xal API operation exists at /api/v1/example.",
    "resolution": "Read https://xal.sh/openapi.json and call a documented operation."
  }
}
```

Unknown API routes return `404`, unsupported methods return `405`, and an `Accept` header that rejects JSON returns `406`.

## OpenAPI and function calling

The [Xal OpenAPI 3.1 specification](https://xal.sh/openapi.json) describes every published operation and response schema. Each operation has a unique `operationId`, a description, and typed JSON responses suitable for client generation or LLM function-calling adapters. The human-readable [Xal developer resources](https://xal.sh/developers) page records authentication, webhook, CLI, plugin, and MCP availability.
