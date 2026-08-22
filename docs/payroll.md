# Employees, shifts, commissions & payroll — v0.4 section C

**Frappe HRMS** (`hrms` **15.63.3**, branch `version-15`) is installed alongside ERPNext. The
Maison glue feature-detects it (`maison_pos.api.hr.hrms_installed()`): without HRMS, shifts
and commissions still work on the Maison doctypes; only the Employee Checkin mirror and the
"hrms" payroll export are skipped.

## Employees

`Maison Associate.employee` (Link → Employee, ERPNext doctype, so it exists with or without
HRMS). The demo seed (`setup/demo_v04_crm_hr.py`) creates one Employee per associate
(`user_id` = login, designation Boutique Manager / Sales Associate…), plus — when HRMS is
present — a submitted **Salary Structure "Maison Base"** (component Basic, `base` 4 000 / month)
and a Salary Structure Assignment per employee so `Additional Salary` rows can be posted.

## Clock-in / out (Unlock screen)

`Maison Shift`: associate, employee, boutique, clock_in, clock_out, status (On shift / On break /
Off shift), break_started / break_minutes / worked_minutes, device_id, `checkin_in` /
`checkin_out` = HRMS `Employee Checkin` names (IN / OUT, `device_id` = `<boutique>:<device>`,
so HRMS Shift Type auto-attendance works if a Shift Type is assigned to the employee).

| Endpoint (`hr.*`) | Notes |
| --- | --- |
| `clock_in(associate, boutique, device_id?)` | idempotent (returns the open shift). Self or Manager+. Boutique-scoped. |
| `clock_out(associate, device_id?)` | closes an open break, computes worked minutes. |
| `toggle_break(associate)` | start / end break. |
| `shift_status(associate?)` | `{on_shift, shift{name, boutique, clock_in, status, break_minutes, worked_minutes}, hrms}` |
| `on_shift(boutique)` | manager view of who is clocked in. |
| `shifts(boutique, from_date?, to_date?)` | Manager+ timesheet list. |

POS: the Unlock screen has a segmented control **Unlock / Clock in / Clock out**; the PIN then
performs the action (clock-out never opens the till). Shift status per associate is cached in
Dexie (`settings.shifts`); the clock actions need a connection.

## Commissions

`Maison Commission Rule`: title, rate %, priority, optional scope (boutique, role Any /
Associate / Manager, item_group, department), validity window. All set scopes must match a
line; highest priority wins, then the most specific rule.

`Maison Commission Entry` (`MCE-YYYY-#####`): one row per invoice line on **Sales Invoice
submit** (`hr.on_invoice_submit`): base = net line amount, rate, commission, rule, associate,
employee, boutique, status Open / Exported / Paid. **Returns** (credit notes, including
`sales.void` / `returns.*`) create negative rows flagged `is_reversal` against the *original
seller* (not the manager voiding). **Cancelling** an invoice adds mirror rows (`reversal_of`).

Statement: `hr.commission_statement(from_date?, to_date?, boutique?, associate?, status?)`
→ per-associate totals + entries (associates see their own, managers their boutique). Desk
report **Maison Commission Statement** (filters boutique / associate / status / detail).

Dashboard tile: `hr.employee_performance(boutique?, from, to)` → sales, tickets, avg ticket,
conversion (tickets with a named client / tickets), follow-ups done, commission.

## Payroll exports

`hr.payroll_export(from_date, to_date, format, boutique?, mark_exported=0)` — Maison Head
Office / System Manager. Aggregates the period's **Open** entries per associate.
`payroll_export_download(...)` streams the CSV from the desk. `mark_exported=1` flips the
entries to *Exported* with an `export_ref` so a period is never exported twice.

| `format` | Output | Columns |
| --- | --- | --- |
| `gusto` | `gusto_commissions_<from>_<to>.csv` — Gusto "Import hours & earnings" | `Last name, First name, Employee ID, Commission` (Employee ID = `Employee.employee_number`, falls back to the associate login) |
| `adp` | `adp_paydata_<from>_<to>.csv` — ADP Workforce Now Paydata import | `Co Code, Batch ID, File #, Earnings 3 Code, Earnings 3 Amount` (Co Code = first 3 letters of the company, Batch ID `COMM<yyyymmdd>`, File # = employee number, code `C` = commission) |
| `quickbooks` | `quickbooks_payroll_<from>_<to>.csv` — QuickBooks Online Payroll earnings import | `Employee, Pay Item, Amount, Period Start, Period End` (Pay Item = Commission) |
| `hrms` | HRMS **Additional Salary** per employee (component *Maison Commission*, `is_additional_component`, payroll_date = `to_date`, submitted) → picked up by the next Payroll Entry. Employees without a Salary Structure Assignment are reported as `rows[].skipped`. |

Map the column names in the payroll provider's import wizard if your account uses a different
template (Gusto and ADP both accept custom mappings on import); amounts are plain decimals,
no currency symbol.

## Scheduler / hooks summary

- Sales Invoice `on_submit`: `hr.on_invoice_submit` (commission), `promotions.on_invoice_submit`
  (coupon redemption), `crm.fulfil_wishlist_on_sale`.
- Sales Invoice `on_cancel`: `hr.on_invoice_cancel`, `promotions.on_invoice_cancel`.
- daily: `promotions.birthday_bonus` (no-op unless `Maison POS Settings.birthday_bonus_points` > 0).
