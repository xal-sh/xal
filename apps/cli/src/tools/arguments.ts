import { isRecord } from "../lib/json"

const UNCHECKED_KEYWORDS = ["$ref", "allOf", "not", "if"]

function typeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "integer":
      return Number.isInteger(value)
    case "number":
    case "string":
    case "boolean":
      return typeof value === type
    case "object":
      return isRecord(value)
    case "array":
      return Array.isArray(value)
    case "null":
      return value === null
    default:
      return true
  }
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object"
}

function nestedPath(path: string, name: string): string {
  return path ? `${path}.${name}` : name
}

function check(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (!isRecord(schema) || UNCHECKED_KEYWORDS.some((keyword) => keyword in schema)) return
  if (value === null && schema.nullable === true) return
  const label = path || "arguments"
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []
  if (branches.length > 0 && !branches.some((branch) => errorsFor(branch, value, path).length === 0)) {
    errors.push(`${label} does not match any of its allowed forms`)
    return
  }
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  if (types.length > 0 && !types.some((type) => hasType(value, type))) {
    errors.push(`${label} must be ${types.join(" or ")}, got ${typeName(value)}`)
    return
  }
  if (Array.isArray(schema.enum) && schema.enum.every(isPrimitive) && !schema.enum.includes(value)) {
    errors.push(`${label} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => check(schema.items, entry, `${label}[${index}]`, errors))
    return
  }
  if (!isRecord(value)) return
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const name of required) {
    if (typeof name === "string" && !Object.hasOwn(value, name)) {
      errors.push(`missing required argument ${nestedPath(path, name)}`)
    }
  }
  for (const [name, entry] of Object.entries(value)) {
    if (Object.hasOwn(properties, name)) {
      if (entry !== null || required.includes(name)) check(properties[name], entry, nestedPath(path, name), errors)
      continue
    }
    if (schema.additionalProperties === false && !("patternProperties" in schema)) {
      const expected = Object.keys(properties).join(", ")
      errors.push(`unknown argument ${nestedPath(path, name)}; expected ${expected || "no arguments"}`)
      continue
    }
    check(schema.additionalProperties, entry, nestedPath(path, name), errors)
  }
}

function errorsFor(schema: unknown, value: unknown, path: string): string[] {
  const errors: string[] = []
  check(schema, value, path, errors)
  return errors
}

export function argumentErrors(schema: unknown, args: unknown): string[] {
  return errorsFor(schema, args, "")
}
