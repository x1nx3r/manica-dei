-- Meridian HRIS — leave management.

create table if not exists department (
  id   text primary key,
  name text not null
);

create table if not exists employee (
  id                 text primary key,
  name               text not null,
  email              text not null unique,
  department_id      text not null references department(id),
  manager_id         text references employee(id),
  employment_type    text not null check (employment_type in ('full_time', 'part_time')),
  fraction           real not null default 1.0,
  start_date         text not null,
  probation_end_date text,
  region             text not null default 'ID'
);

create table if not exists leave_type (
  id   text primary key,
  code text not null unique,
  name text not null
);

create table if not exists leave_policy (
  id               text primary key,
  leave_type_id    text not null references leave_type(id),
  entitlement_days real not null,
  carryover_cap    real not null,
  accrual_cadence  text not null check (accrual_cadence in ('monthly', 'annual')),
  effective_from   text not null
);

create table if not exists leave_balance (
  id            text primary key,
  employee_id   text not null references employee(id),
  leave_type_id text not null references leave_type(id),
  period_year   integer not null,
  accrued       real not null default 0,
  used          real not null default 0,
  carried_over  real not null default 0,
  adjustment    real not null default 0,
  unique (employee_id, leave_type_id, period_year)
);

create table if not exists leave_request (
  id            text primary key,
  employee_id   text not null references employee(id),
  leave_type_id text not null references leave_type(id),
  start_date    text not null,
  end_date      text not null,
  days          real not null,
  status        text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    text references employee(id),
  decided_at    text
);

create table if not exists public_holiday (
  date   text not null,
  name   text not null,
  region text not null,
  primary key (date, region)
);
