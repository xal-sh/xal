const DAY_MS = 24 * 60 * 60 * 1000

export function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

export function calendarDayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function localDateKey(date: Date): string {
  return calendarDayKey(localCalendarDay(date))
}

export function dateKeyCalendarDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / DAY_MS
}

export function calendarDayOfWeek(day: number): number {
  return new Date(day * DAY_MS).getUTCDay()
}

export function calendarDayOfMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCDate()
}

export function calendarDayMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCMonth()
}
