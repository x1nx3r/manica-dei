import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"

const SCHEMA = new URL("./schema.sql", import.meta.url)

/**
 * Load the demo dataset. Pass a path to persist it, or nothing for an
 * in-memory database (used by the tests).
 */
export function seed(path = ":memory:"): Database {
  const db = new Database(path)
  db.run(readFileSync(SCHEMA, "utf8"))

  db.run(
    `insert into department (id, name) values
       ('d_eng', 'Engineering'),
       ('d_ops', 'Operations')`,
  )

  db.run(
    `insert into employee
       (id, name, email, department_id, manager_id, employment_type, fraction, start_date, probation_end_date, region)
     values
       ('e_ada',   'Ada',   'ada@meridian.example',   'd_ops', null,    'full_time', 1.0, '2019-02-01', null,         'ID'),
       ('e_budi',  'Budi',  'budi@meridian.example',  'd_eng', 'e_ada', 'full_time', 1.0, '2021-06-14', null,         'ID'),
       ('e_citra', 'Citra', 'citra@meridian.example', 'd_eng', 'e_ada', 'part_time', 0.5, '2023-09-01', null,         'ID'),
       ('e_dewi',  'Dewi',  'dewi@meridian.example',  'd_ops', 'e_ada', 'full_time', 1.0, '2026-02-01', '2026-05-01', 'SG')`,
  )

  db.run(
    `insert into leave_type (id, code, name) values
       ('lt_annual', 'annual', 'Annual leave'),
       ('lt_sick',   'sick',   'Sick leave'),
       ('lt_unpaid', 'unpaid', 'Unpaid leave')`,
  )

  db.run(
    `insert into leave_policy
       (id, leave_type_id, entitlement_days, carryover_cap, accrual_cadence, effective_from)
     values
       ('lp_annual', 'lt_annual', 12, 10, 'monthly', '2026-01-01'),
       ('lp_sick',   'lt_sick',    6,  0, 'annual',  '2026-01-01'),
       ('lp_unpaid', 'lt_unpaid',  0,  0, 'annual',  '2026-01-01')`,
  )

  db.run(
    `insert into public_holiday (date, name, region) values
       ('2026-01-01', 'New Year',           'ID'),
       ('2026-03-19', 'Nyepi',              'ID'),
       ('2026-05-02', 'Idul Fitri (day 2)', 'ID'),
       ('2026-05-01', 'Labour Day',         'SG'),
       ('2026-08-09', 'National Day',       'SG')`,
  )

  return db
}

if (import.meta.main) {
  const db = seed("hris.db")
  const row = db.query("select count(*) as n from employee").get() as { n: number }
  console.log(`seeded hris.db — ${row.n} employees`)
}
