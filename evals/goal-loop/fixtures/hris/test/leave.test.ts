import { expect, test } from "bun:test"
import { approve, cancel, reject, type LeaveRequest } from "../src/domain/leave"

const manager = { id: "e_ada" }
const report = { id: "e_budi", managerId: "e_ada" }
const colleague = { id: "e_citra", managerId: "e_ada" }

const pending: LeaveRequest = {
  id: "lr_1",
  employeeId: "e_budi",
  leaveTypeId: "lt_annual",
  startDate: "2026-03-16",
  endDate: "2026-03-20",
  days: 4,
  status: "pending",
}

test("the reporting manager can approve", () => {
  const decided = approve(pending, manager, report, "2026-03-10T09:00:00Z")
  expect(decided.status).toBe("approved")
  expect(decided.decidedBy).toBe("e_ada")
})

test("someone who is not the manager cannot approve", () => {
  expect(() => approve(pending, colleague, report, "2026-03-10T09:00:00Z")).toThrow()
})

test("a decided request cannot be approved again", () => {
  const decided = approve(pending, manager, report, "2026-03-10T09:00:00Z")
  expect(() => approve(decided, manager, report, "2026-03-11T09:00:00Z")).toThrow()
})

test("the manager can reject", () => {
  expect(reject(pending, manager, report, "2026-03-10T09:00:00Z").status).toBe("rejected")
})

test("a pending request can be cancelled", () => {
  expect(cancel(pending).status).toBe("cancelled")
})
