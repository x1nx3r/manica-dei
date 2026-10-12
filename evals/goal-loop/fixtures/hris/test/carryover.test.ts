import { expect, test } from "bun:test"
import { carryover } from "../src/domain/carryover"
import { seed } from "../src/db/seed"

test("unused leave carries over up to the cap", () => {
  expect(carryover(14, 10)).toBe(10)
})

test("unused leave below the cap carries in full", () => {
  expect(carryover(3, 10)).toBe(3)
})

test("a negative balance carries nothing", () => {
  expect(carryover(-2, 10)).toBe(0)
})

test("the annual policy caps carry-over at 10 days", () => {
  const db = seed()
  const row = db.query("select carryover_cap as cap from leave_policy where id = 'lp_annual'").get() as { cap: number }
  expect(row.cap).toBe(10)
})
