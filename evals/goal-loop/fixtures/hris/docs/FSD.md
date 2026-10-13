# FSD — Leave Management

Status: current
Owner: Platform
Last updated: 2026-01-20

Behavioural and technical specification for the leave module. Where the code
and this document disagree, treat this document as the intent.

## 1. Scope

Leave requests, balances, accrual, carry-over, and approval for the `annual`,
`sick`, and `unpaid` leave types.

## 2. Domain model

```sql
employee(id, name, email, department_id, manager_id,
         employment_type, start_date, probation_end_date, region)

leave_policy(id, leave_type_id, entitlement_days, carryover_cap,
             accrual_cadence, effective_from)

leave_balance(id, employee_id, leave_type_id, period_year,
              accrued, used, carried_over, adjustment)

leave_request(id, employee_id, leave_type_id, start_date, end_date,
              days, status, decided_by, decided_at)

public_holiday(date, name, region)
```

`carryover_cap` defaults to **5** days. `accrual_cadence` is `monthly` for
annual leave and `annual` for the rest.

## 3. Workflows

### Leave request

```
        ┌──────────┐
        │ pending  │
        └────┬─────┘
   approve │ reject │ cancel
     ┌─────┴───┐   │
     ▼         ▼   ▼
 approved  rejected cancelled

  pending ──▶ escalated        (an unattended request escalates after 5 days)
```

Only the employee's reporting manager may approve or reject. The decision is
recorded in `decided_by` and `decided_at`.

### The HR queue

The HR manager's view is a queue — `GET /leave/queue`, which `route` maps to
`{ kind: "queue" }`. It lists the requests that have reached her: a request that
sat unattended long enough to escalate **appears in this queue**, assigned to
her, and she may approve or reject it like any other manager. A request that
escalates and cannot be seen here has not escalated, as far as the business is
concerned.

### Accrual

A nightly job credits each active employee on the first day of the month:

```
credit = entitlement_days / 12
```

Employees on probation do not accrue.

### Carry-over

At year end the unused balance carries into the next year:

```
carried_over = min(unused, carryover_cap)      # carryover_cap = 5
```

The remainder is forfeited.

## 4. Day counting

A request's `days` is the number of **working days** in `[start, end]`.
Weekends and public holidays (by the employee's region) are not working days.

## 5. Interfaces

- `POST /leave/request` — create a request.
- `POST /leave/approve` — approve a request.
- `POST /leave/reject` — reject a request.
- `GET  /leave/balance` — read a balance.

## 6. Out of scope

Payroll calculation, scheduling, and notifications.
