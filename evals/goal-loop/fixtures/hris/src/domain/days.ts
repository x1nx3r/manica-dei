export type Holiday = { date: string; name: string; region: string }

/**
 * A leave day is a working day: not a weekend, and not a public holiday in the
 * employee's region. `[start, end]` is inclusive.
 */
export function countLeaveDays(start: string, end: string, region: string, holidays: Holiday[]): number {
  const working = datesBetween(start, end).filter((date) => !isWeekend(date))
  const observed = holidays.filter((h) => h.region === region && h.date >= start && h.date <= end)
  return working.length - observed.length
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = []
  const last = Date.parse(`${end}T00:00:00Z`)
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= last; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}
