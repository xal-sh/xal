import { appInfo } from "./app-info.ts"
import { INSTALL_COMMAND, PRODUCT_DESCRIPTION, REPOSITORY, SITE_URL } from "./site.ts"

export const product = {
  name: "Xal",
  command: "xal",
  version: appInfo.version,
  status: "beta",
  description: PRODUCT_DESCRIPTION,
  url: SITE_URL,
  repository: REPOSITORY,
  documentation: `${SITE_URL}/docs`,
  license: "MIT",
  installCommand: INSTALL_COMMAND,
  platforms: ["macOS", "Linux", "Windows"],
  architectures: ["x64", "arm64"],
  capabilities: [
    "repository inspection and editing",
    "permission-gated shell commands",
    "language server integration",
    "Model Context Protocol client integration",
    "multiple AI providers",
    "plugins, skills, and custom commands",
    "persistent sessions and background jobs",
    "sub-agents and worktree isolation",
  ],
  resources: {
    developers: `${SITE_URL}/developers`,
    openapi: `${SITE_URL}/openapi.json`,
    llms: `${SITE_URL}/llms.txt`,
    cli: `${SITE_URL}/cli`,
    contact: `${SITE_URL}/contact`,
    privacy: `${SITE_URL}/privacy`,
  },
}

export const openApi = {
  openapi: "3.1.0",
  info: {
    title: "Xal Public API",
    version: "1.0.0",
    description:
      "Public, read-only metadata for Xal, the terminal coding harness. No authentication is required. Every error is returned as JSON with a stable code and a resolution hint.",
    license: {
      name: "MIT",
      identifier: "MIT",
      url: `${REPOSITORY}/blob/main/LICENSE`,
    },
  },
  servers: [{ url: `${SITE_URL}/api/v1`, description: "Production" }],
  externalDocs: { description: "Xal developer resources", url: `${SITE_URL}/developers` },
  paths: {
    "/product": {
      get: {
        operationId: "getXalProduct",
        summary: "Get Xal product metadata",
        description:
          "Returns the current Xal version, beta status, supported platforms, install command, capabilities, and canonical developer resource links. Use this operation when an agent needs to identify Xal or direct a user to an official integration surface.",
        tags: ["Product"],
        responses: {
          "200": {
            description: "Canonical Xal product metadata.",
            headers: {
              "Cache-Control": {
                description: "Public cache policy for this metadata response.",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Product" } },
            },
          },
          "405": {
            description: "The request uses a method other than GET, HEAD, or OPTIONS.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
          "406": {
            description: "The request explicitly rejects application/json.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "command",
          "version",
          "status",
          "description",
          "url",
          "repository",
          "documentation",
          "license",
          "installCommand",
          "platforms",
          "architectures",
          "capabilities",
          "resources",
        ],
        properties: {
          name: { type: "string", description: "Official product name.", examples: ["Xal"] },
          command: { type: "string", description: "Installed CLI command.", examples: ["xal"] },
          version: { type: "string", description: "Current website build's Xal semantic version." },
          status: { type: "string", enum: ["beta"], description: "Current release stability channel." },
          description: { type: "string", description: "Concise canonical product description." },
          url: { type: "string", format: "uri", description: "Canonical Xal website." },
          repository: { type: "string", format: "uri", description: "Official source repository." },
          documentation: { type: "string", format: "uri", description: "Official documentation index." },
          license: { type: "string", enum: ["MIT"], description: "SPDX license identifier." },
          installCommand: { type: "string", description: "Official beta installation shell command." },
          platforms: {
            type: "array",
            description: "Supported operating-system families.",
            items: { type: "string", enum: ["macOS", "Linux", "Windows"] },
          },
          architectures: {
            type: "array",
            description: "Supported processor architectures.",
            items: { type: "string", enum: ["x64", "arm64"] },
          },
          capabilities: {
            type: "array",
            description: "High-level jobs available in the Xal coding harness.",
            items: { type: "string" },
          },
          resources: {
            type: "object",
            additionalProperties: false,
            description: "Canonical machine-readable, developer, support, and policy links.",
            required: ["developers", "openapi", "llms", "cli", "contact", "privacy"],
            properties: {
              developers: { type: "string", format: "uri" },
              openapi: { type: "string", format: "uri" },
              llms: { type: "string", format: "uri" },
              cli: { type: "string", format: "uri" },
              contact: { type: "string", format: "uri" },
              privacy: { type: "string", format: "uri" },
            },
          },
        },
      },
      Error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "resolution"],
        properties: {
          code: { type: "string", description: "Stable machine-readable error code." },
          message: { type: "string", description: "Human-readable explanation of the error." },
          resolution: { type: "string", description: "Specific action that can resolve the error." },
        },
      },
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: { error: { $ref: "#/components/schemas/Error" } },
      },
    },
  },
}

export function jsonError(
  code: string,
  message: string,
  resolution: string,
): { error: { code: string; message: string; resolution: string } } {
  return { error: { code, message, resolution } }
}
