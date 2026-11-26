export function formatHeading() {
  return "Name".padEnd(10) + "Team".padEnd(10) + "Role".padEnd(10)
}

export function formatPlayer(name, team, role, points) {
  return name.padEnd(10) + team.padEnd(10) + role.padEnd(10) + String(points).padStart(10)
}

export function formatSummary(team, points) {
  return ("Total".padEnd(10) + team.padEnd(10) + String(points).padEnd(10)).padEnd(100)
}
