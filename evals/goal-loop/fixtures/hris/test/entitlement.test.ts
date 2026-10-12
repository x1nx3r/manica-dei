import { expect, test } from "bun:test"
import { accrualFor, type Employee, type LeavePolicy } from "../src/domain/entitlement"

const annual: LeavePolicy = { entitlementDays: 12, accrualCadence: "monthly" }

const fullTime: Employee = { id: "e_budi", employmentType: "full_time", fraction: 1, startDate: "2021-06-14" }
const partTime: Employee = { id: "e_citra", employmentType: "part_time", fraction: 0.5, startDate: "2023-09-01" }
const newHire: Employee = {
  id: "e_dewi",
  employmentType: "full_time",
  fraction: 1,
  startDate: "2026-02-01",
  probationEndDate: "2026-05-01",
}

test("full-time staff accrue a twelfth of the entitlement each month", () => {
  expect(accrualFor(fullTime, annual, "2026-03-01")).toBe(1)
})

test("part-time staff accrue pro-rata", () => {
  expect(accrualFor(partTime, annual, "2026-03-01")).toBe(0.5)
})

test("staff on probation do not accrue", () => {
  expect(accrualFor(newHire, annual, "2026-03-01")).toBe(0)
})

test("accrual resumes after probation", () => {
  expect(accrualFor(newHire, annual, "2026-06-01")).toBe(1)
})

test("an annual cadence credits the full entitlement", () => {
  expect(accrualFor(fullTime, { entitlementDays: 6, accrualCadence: "annual" }, "2026-03-01")).toBe(6)
})
