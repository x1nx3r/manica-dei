import { expect, test } from "bun:test"
import { countLeaveDays, type Holiday } from "../src/domain/days"

const holidays: Holiday[] = [
  { date: "2026-01-01", name: "New Year", region: "ID" },
  { date: "2026-03-19", name: "Nyepi", region: "ID" },
  { date: "2026-05-02", name: "Idul Fitri (day 2)", region: "ID" },
  { date: "2026-05-01", name: "Labour Day", region: "SG" },
]

test("counts the working days in a week", () => {
  expect(countLeaveDays("2026-03-16", "2026-03-20", "ID", holidays)).toBe(4)
})

test("a single working day is one day", () => {
  expect(countLeaveDays("2026-03-17", "2026-03-17", "ID", holidays)).toBe(1)
})

test("a weekend is no days", () => {
  expect(countLeaveDays("2026-03-14", "2026-03-15", "ID", holidays)).toBe(0)
})

test("a holiday in another region is a working day", () => {
  expect(countLeaveDays("2026-05-01", "2026-05-01", "ID", holidays)).toBe(1)
})
