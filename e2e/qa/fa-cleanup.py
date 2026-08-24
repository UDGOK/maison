"""Final-acceptance cleanup: cancel everything this acceptance run created on the live site.

Order matters: credit notes before the sales they are against, invoices before the sales orders
they were billed from, payment entries before their order. Everything is reported; nothing is
deleted (cancelled documents keep the audit trail).
"""
import json, sys, urllib.parse, subprocess

BASE = "https://cloudchaserz.frappe.cloud"
SID = open('/tmp/ccsid').read().strip()
CSRF = open('/tmp/cccsrf').read().strip()

def call(method, data=None, params=None):
    if data is None:
        url = f"{BASE}/api/method/{method}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        cmd = ["curl", "-s", "-b", f"sid={SID}", url]
    else:
        cmd = ["curl", "-s", "-b", f"sid={SID}", "-X", "POST",
               "-H", "Content-Type: application/json", "-H", f"X-Frappe-CSRF-Token: {CSRF}",
               f"{BASE}/api/method/{method}", "-d", json.dumps(data)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out[:300]}

def lst(doctype, filters, fields, limit=0, order_by=None, parent=None):
    p = {"doctype": doctype, "filters": json.dumps(filters), "fields": json.dumps(fields), "limit_page_length": limit}
    if order_by: p["order_by"] = order_by
    if parent: p["parent"] = parent
    return call("frappe.client.get_list", params=p).get("message", [])

def cancel(doctype, name):
    r = call("frappe.client.cancel", {"doctype": doctype, "name": name})
    ok = isinstance(r.get("message"), dict) and r["message"].get("docstatus") == 2
    return ok, ("" if ok else str(r.get("exception") or r.get("_server_messages") or r)[:180])

SINCE = "2026-08-24 10:15:00"      # this acceptance run started at 10:15 site time
report = {"cancelled": [], "failed": [], "disabled": [], "stock": []}

# ---------------------------------------------------------------- 1. web orders (invoice, payment, order)
orders = lst("Sales Order", [["creation", ">", SINCE]], ["name", "docstatus", "status", "customer"], order_by="creation asc")
for so in orders:
    # the counter invoice billed against it
    for si in lst("Sales Invoice", [["docstatus", "=", 1], ["creation", ">", SINCE]], ["name"]):
        pass
print(f"sales orders since {SINCE}: {[o['name'] for o in orders]}")

# ---------------------------------------------------------------- 2. invoices: credit notes first
invs = lst("Sales Invoice", [["creation", ">", SINCE]], ["name", "docstatus", "is_return", "return_against", "customer", "grand_total"], order_by="creation desc")
credits = [i for i in invs if i["is_return"] and i["docstatus"] == 1]
sales = [i for i in invs if not i["is_return"] and i["docstatus"] == 1]
for i in credits + sales:
    ok, err = cancel("Sales Invoice", i["name"])
    (report["cancelled"] if ok else report["failed"]).append(i["name"] if ok else {"doc": i["name"], "err": err})
    print(("  cancelled " if ok else "  FAILED    ") + i["name"] + ("" if ok else " — " + err))

# ---------------------------------------------------------------- 3. payment entries, then the orders
for so in orders:
    pes = lst("Payment Entry Reference", [["reference_name", "=", so["name"]], ["docstatus", "=", 1]], ["parent"], parent="Payment Entry")
    for pe in {p["parent"] for p in pes}:
        ok, err = cancel("Payment Entry", pe)
        (report["cancelled"] if ok else report["failed"]).append(pe if ok else {"doc": pe, "err": err})
        print(("  cancelled " if ok else "  FAILED    ") + pe + ("" if ok else " — " + err))
    ok, err = cancel("Sales Order", so["name"])
    (report["cancelled"] if ok else report["failed"]).append(so["name"] if ok else {"doc": so["name"], "err": err})
    print(("  cancelled " if ok else "  FAILED    ") + so["name"] + ("" if ok else " — " + err))

json.dump(report, open('/home/claude/maison/e2e/qa/cleanup-final.json', 'w'), indent=1)
print(json.dumps({k: len(v) for k, v in report.items()}))
