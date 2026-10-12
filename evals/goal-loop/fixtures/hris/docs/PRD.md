# PRD — Leave Management

Status: current
Owner: People Operations
Last updated: 2026-01-12

## Context

Meridian Group has ~200 staff across two regions, Indonesia (ID) and Singapore
(SG). Leave is tracked today in a shared spreadsheet. People Ops wants it in
the HRIS so balances are trustworthy and payroll can be fed from it.

## Users

- **Employee** — requests leave, checks their balance.
- **Manager** — approves leave for their reports.
- **HR manager** — owns the policies, fixes balances, handles exceptions.
- **Payroll** — exports approved leave for the pay run.

## Outcomes

1. An employee can request leave for a date range and see the day count.
2. A manager can approve or reject a request for their own reports.
3. Balances are visible and correct: accrued, used, carried over.
4. Payroll can export approved leave per period.

## Requirements

- **Fair accrual.** Staff accrue leave over the year, in step with their
  contract. Someone who joins mid-year should not be over- or under-credited.
- **Reasonable carry-over.** Unused leave should not vanish at year end, but it
  should not pile up forever either.
- **Public holidays.** A leave day is a working day. Company holidays do not
  count against a balance.
- **Audit.** Every decision (approve or reject) is attributable to a person.

## Non-goals

- No payroll calculation — we export, payroll computes.
- No scheduling or rostering.
- No mobile app.

## Open questions

- What is a "reasonable" carry-over cap? (People Ops: "a week or so".)
- Should leave accrue while an employee is on probation?
