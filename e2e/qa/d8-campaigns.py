#!/usr/bin/env python3
"""D8 — campaign loop: touches -> attribution -> direct vs assisted -> performance card -> segment export. Cleans up."""
import json, time
from datetime import date, timedelta
import dq

CSRF = open("/tmp/cccsrf").read().strip()
C = "EVENTS-LAUNCH"
TODAY = date(2026, 8, 23)
def post(m, p): return dq.call(m, p, post=True, csrf=CSRF)

results = {}
# 1. find candidate buyers: an invoice 3 days ago (inside direct window) and one 20 days ago (assisted only)
def buyer_on(d):
    rows = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"posting_date":str(d),"is_return":0},
                       fields=["name","customer","maison_boutique","grand_total","net_total","posting_date"], limit=200)
    walk = set(r["customer"] for r in dq.get_list("POS Profile", fields=["customer"], limit=50))
    for r in rows:
        if r["customer"] and r["customer"] not in walk:
            cust = dq.get_list("Customer", filters={"name":r["customer"]}, fields=["name","email_id","disabled"], limit=1)
            if cust and cust[0].get("email_id") and not cust[0].get("disabled"): return r
    return None
direct_inv = buyer_on(TODAY - timedelta(days=3)) or buyer_on(TODAY - timedelta(days=2))
assist_inv = buyer_on(TODAY - timedelta(days=20)) or buyer_on(TODAY - timedelta(days=19))
print("direct candidate:", direct_inv)
print("assist candidate:", assist_inv)

# 2. record touches (touch time strictly before the sale)
t1 = post("maison_pos.api.campaigns.record_touch", {"campaign":C, "customer":direct_inv["customer"], "event":"clicked",
      "ts": f"{TODAY - timedelta(days=5)} 10:00:00", "source":"Manual"})
t2 = post("maison_pos.api.campaigns.record_touch", {"campaign":C, "customer":assist_inv["customer"], "event":"sent",
      "ts": f"{TODAY - timedelta(days=25)} 10:00:00", "source":"Manual"})
print("touch1:", json.dumps(t1, default=str)[:250])
print("touch2:", json.dumps(t2, default=str)[:250])
results["touches"] = [t1.get("message"), t2.get("message")]
touch_names = [t.get("message",{}).get("touch") for t in (t1,t2)]

# 3. run attribution over the last 45 days
job = post("maison_pos.api.campaigns.run_attribution", {"from_date": str(TODAY - timedelta(days=45)), "to_date": str(TODAY), "campaign": C})
print("\nrun_attribution:", json.dumps(job.get("message", job), default=str)[:600])
results["job"] = job.get("message")

# 4. inspect the attribution rows
rows = dq.get_list("Maison Campaign Attribution", fields=["name","sales_invoice","campaign","customer","type","amount","invoice_total","item_level","touch_at","days_to_sale","posting_date","boutique","associate"], limit=100)
print(f"\nattribution rows: {len(rows)}")
for r in rows: print("  ", json.dumps(r, default=str))
results["rows"] = rows

# 5. verify the rule by hand
ok = []
for r in rows:
    inv = dq.get_list("Sales Invoice", filters={"name":r["sales_invoice"]}, fields=["name","posting_date","net_total","grand_total","customer"], limit=1)[0]
    d = (date.fromisoformat(str(inv["posting_date"])) - date.fromisoformat(str(r["touch_at"])[:10])).days
    want = "Direct" if d <= 14 else "Assisted"
    amt_ok = abs(float(r["amount"]) - float(inv["net_total"])) < 0.011
    ok.append(f"{r['sales_invoice']} {r['customer']}: type={r['type']} (days_to_sale={r['days_to_sale']}, hand={d} -> expect {want}) "
              f"amount={r['amount']} vs invoice net_total={inv['net_total']} {'OK' if (r['type']==want and amt_ok) else '*** MISMATCH ***'}")
print("\nrule check:"); [print("  ", x) for x in ok]
results["rule_check"] = ok

# 6. performance card
perf = dq.call("maison_pos.api.campaigns.performance")["message"]
p0 = perf["campaigns"][0]
print(f"\nperformance: sends={p0['sends']} opens={p0['opens']} clicks={p0['clicks']} direct={p0['attributed_direct']} assisted={p0['attributed_assisted']} "
      f"buyers={p0['buyers']} inv_direct={p0['invoices_direct']} inv_assisted={p0['invoices_assisted']} revenue={p0['attributed_revenue']} roi={p0['roi']}")
print("totals:", json.dumps(perf["totals"], default=str))
results["performance"] = p0
asales = dq.call("maison_pos.api.campaigns.attributed_sales", {"campaign":C})["message"]
print(f"attributed_sales rows: {len(asales)}")
results["attributed_sales"] = asales

# 7. desk report picks it up
rep = dq.call("frappe.desk.query_report.run", {"report_name":"Maison Campaign Performance",
      "filters": json.dumps({"from_date": str(TODAY - timedelta(days=45)), "to_date": str(TODAY)}), "ignore_prepared_report":1})["message"]
r0 = rep["result"][0]
print(f"desk report: direct={r0.get('attributed_direct')} assisted={r0.get('attributed_assisted')} buyers={r0.get('buyers')} chart={'yes' if rep.get('chart') else 'no'}")
results["desk_report"] = r0

# 8. segment export
import subprocess
SID=open('/tmp/ccsid').read().strip()
url = "https://cloudchaserz.frappe.cloud/api/method/maison_pos.api.campaigns.export_segment?campaign=EVENTS-LAUNCH&format=csv"
out = subprocess.run(["curl","-s","-D-","-H",f"Cookie: sid={SID}",url], capture_output=True, text=True).stdout
head = [l for l in out.split("\n") if l.lower().startswith(("http/","content-disposition","content-type"))]
body = out.split("\r\n\r\n",1)[-1] if "\r\n\r\n" in out else out
print("\nexport_segment(csv):", head)
print("  first 2 lines:", " || ".join(body.strip().split("\n")[:2])[:260])
print("  data lines:", max(0, len(body.strip().split("\n"))-1))
results["export_csv_lines"] = max(0, len(body.strip().split("\n"))-1)
results["export_headers"] = head
json.dump(results, open("/home/claude/maison/e2e/qa/results-d8.json","w"), indent=1, default=str)
json.dump({"touches":touch_names,"attributions":[r["name"] for r in rows]}, open("/home/claude/maison/e2e/qa/created-campaign.json","w"), indent=1)
