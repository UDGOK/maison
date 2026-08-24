import sys, json
sys.path.insert(0, "/home/claude/maison/e2e/qa")
from harness import sess, summ

OWN, OTHER = "OK-MINGO", "OK-ETUL"

def names(r, key="name"):
    try:
        return [x.get(key) for x in r.json().get("message", [])]
    except Exception:
        return f"ERR {r.status_code}"

def get_list(s, doctype, filters=None, fields=None, limit=2000, order_by=None):
    p = dict(doctype=doctype, limit_page_length=limit)
    if filters is not None: p["filters"] = json.dumps(filters)
    if fields is not None: p["fields"] = json.dumps(fields)
    if order_by: p["order_by"] = order_by
    return s.get("frappe.client.get_list", **p)

mgr = sess("manager")       # Maison Manager @ OK-MINGO
asc = sess("associate")     # Maison Associate @ OK-MINGO
print("========== D3 re-verify: manager lists OTHER store's Sales Invoices / returns ==========")
for label, filt in [
    ("other-store invoices", [["maison_boutique","=",OTHER]]),
    ("other-store RETURNS",  [["maison_boutique","=",OTHER],["is_return","=",1]]),
    ("ANY return chain-wide",[["is_return","=",1]]),
    ("blank-stamp invoices", [["maison_boutique","in",["",None]]]),
]:
    r = get_list(mgr, "Sales Invoice", filters=filt, fields=["name","maison_boutique","is_return","grand_total"])
    rows = r.json().get("message", []) if r.ok else r.text[:120]
    other = [x for x in rows if isinstance(x,dict) and x.get("maison_boutique") not in (OWN, None, "")] if r.ok else rows
    print(f"  [{r.status_code}] {label}: total={len(rows) if r.ok else '?'}  leaked_other_store={len(other) if r.ok else '?'}  sample={other[:2]}")

print("========== sensitive doctypes cross-store leak (as MANAGER @ OK-MINGO) ==========")
tests = [
    ("Sales Order",        [["maison_boutique","=",OTHER]], ["name","maison_boutique"]),
    ("Delivery Note",      None, ["name","set_warehouse"]),
    ("Stock Entry",        None, ["name","from_warehouse","to_warehouse"]),
    ("Material Request",   None, ["name","set_warehouse"]),
    ("Purchase Receipt",   None, ["name","set_warehouse"]),
    ("Maison Shipment",    [["boutique","=",OTHER]], ["name","boutique","status"]),
    ("Maison Replenishment Request", [["boutique","=",OTHER]], ["name","boutique"]),
    ("Maison Stock Alert", [["boutique","=",OTHER]], ["name","boutique"]),
    ("Maison Feedback",    [["boutique","=",OTHER]], ["name","boutique"]),
    ("Maison Age Check",   [["boutique","=",OTHER]], ["name","boutique"]),
    ("Maison Biometric Consent", [["boutique","=",OTHER]], ["name","boutique"]),
]
for dt, filt, fields in tests:
    r = get_list(mgr, dt, filters=filt, fields=fields)
    if r.ok:
        rows = r.json().get("message", [])
        # count rows that reference OTHER store / non-own warehouse
        leaked = [x for x in rows if (x.get("boutique")==OTHER) or (dt in ("Stock Entry","Delivery Note","Material Request","Purchase Receipt") and rows)]
        print(f"  [{r.status_code}] {dt}: rows={len(rows)}  other_store_rows={sum(1 for x in rows if x.get('boutique')==OTHER)}  sample={rows[:2]}")
    else:
        print(f"  [{r.status_code}] {dt}: {r.text[:100]}")

print("========== Maison Associate PIN-hash exposure ==========")
for who in ("associate","manager"):
    s = sess(who)
    r = get_list(s, "Maison Associate", fields=["name","user","boutique","role","pin","pin_hash","full_name"], limit=50)
    print(f"  as {who}: [{r.status_code}] {str(r.json().get('message'))[:300] if r.ok else r.text[:150]}")
# also try reading a single Associate doc from OTHER store to see PIN fields
r = sess("manager").get("frappe.client.get", doctype="Maison Associate", name="ok.etul.a1@cloudchaserz.example")
print("  manager get OTHER-store associate doc:", summ(r)[:300])

print("========== Customer cross-store read (are clients global?) ==========")
r = get_list(mgr, "Customer", fields=["name","customer_name","maison_client_number","mobile_no","email_id"], limit=5, order_by="creation desc")
print("  manager Customer list:", summ(r)[:300])
rc = sess("manager").get("maison_pos.api.customers.search", q="a", limit=5)
print("  manager customers.search:", summ(rc)[:200])

print("========== Maison POS Settings & User read ==========")
r = sess("manager").get("frappe.client.get", doctype="Maison POS Settings", name="Maison POS Settings")
print("  manager reads POS Settings singleton:", summ(r)[:250])
r = get_list(sess("associate"), "User", fields=["name","email","api_key","api_secret"], limit=5)
print("  associate lists User (api keys?):", summ(r)[:250])
