import { round2 } from "./number"

/**
 * The balance that survives the year end: unused leave up to the policy cap.
 * A negative balance carries nothing.
 */
export function carryover(unused: number, cap: number): number {
  return round2(Math.min(Math.max(unused, 0), cap))
}
