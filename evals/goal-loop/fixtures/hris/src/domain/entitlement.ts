import { round2 } from "./number"

export type Employee = {
  id: string
  employmentType: "full_time" | "part_time"
  fraction: number
  startDate: string
  probationEndDate?: string | null
}

export type LeavePolicy = {
  entitlementDays: number
  accrualCadence: "monthly" | "annual"
}

export function onProbation(employee: Employee, asOf: string): boolean {
  return employee.probationEndDate != null && asOf < employee.probationEndDate
}

/**
 * Leave credited for the period ending `asOf`. Part-time staff accrue in
 * proportion to their contracted fraction.
 */
export function accrualFor(employee: Employee, policy: LeavePolicy, asOf: string): number {
  if (onProbation(employee, asOf)) return 0
  const base = policy.accrualCadence === "monthly" ? policy.entitlementDays / 12 : policy.entitlementDays
  return round2(base * employee.fraction)
}
