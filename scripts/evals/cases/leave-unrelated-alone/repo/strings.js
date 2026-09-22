export function titleCase(value) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase())
}

export function truncate(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value
}
