#!/usr/bin/env python3
"""D9 — recompute Daily Sales, Sales by Item, Sales by Associate, Hourly Heatmap, Returns, Client Purchases."""
import json
from collections import defaultdict
from datetime import date
import dq

DAY="2026-08-23"; B="HOU-MTR"
def run(rep, f):
    return dq.call("frappe.desk.query_report.run", {"report_name":rep,"filters":json.dumps(f),"ignore_prepared_report":1}).get("message",{})
def rows(m): return [r for r in m.get("result",[]) if isinstance(r,dict)]

inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"maison_boutique":B,"posting_date":DAY},
   fields=["name","is_return","net_total","total","discount_amount","total_taxes_and_charges","grand_total","change_amount","posting_time","maison_associate","customer"], limit=500)
names=[r["name"] for r in inv]; byn={r["name"]:r for r in inv}
lines=[]; pays=[]
for i in range(0,len(names),80):
    ch=names[i:i+80]
    lines += dq.get_list("Sales Invoice Item", filters={"parent":("in",ch),"parenttype":"Sales Invoice"}, fields=["parent","item_code","item_name","qty","amount","net_amount","discount_amount"], limit=5000, parent="Sales Invoice")
    pays  += dq.get_list("Sales Invoice Payment", filters={"parent":("in",ch),"parenttype":"Sales Invoice"}, fields=["parent","mode_of_payment","amount"], limit=5000, parent="Sales Invoice")
walk=set(r["customer"] for r in dq.get_list("POS Profile", fields=["customer"], limit=50))
issues=[]

# ---- Daily Sales ----
m = run("AWANZ Daily Sales", {"from_date":DAY,"to_date":DAY,"boutique":B})
ds = rows(m)[0]
print("DAILY SALES row:", json.dumps(ds, default=str))
gross=sum(float(r["net_total"]) for r in inv if not r["is_return"])
retv=sum(abs(float(r["net_total"])) for r in inv if r["is_return"])
netsales=sum(float(r["net_total"]) for r in inv)
tax=sum(float(r["total_taxes_and_charges"] or 0) for r in inv)
tickets=len([r for r in inv if not r["is_return"]]); rets=len([r for r in inv if r["is_return"]])
cash=sum(float(p["amount"]) for p in pays if (p["mode_of_payment"] or "").lower()=="cash") - sum(float(r["change_amount"] or 0) for r in inv if not r["is_return"])
card=sum(float(p["amount"]) for p in pays if (p["mode_of_payment"] or "").lower()!="cash")
units=sum(abs(float(l["qty"])) for l in lines if not byn[l["parent"]]["is_return"])
calc=dict(gross_sales=round(gross,2), returns_value=round(retv,2), net_sales=round(netsales,2), tax=round(tax,2),
          tickets=tickets, returns=rets, cash=round(cash,2), card=round(card,2))
for k,v in calc.items():
    if k in ds:
        a=ds[k]
        st = "OK" if abs(float(a)-float(v))<=0.011 else "*** MISMATCH ***"
        print(f"  {k:15} report={a:>10} calc={v:>10}  {st}")
        if st!="OK": issues.append(f"DailySales.{k}: {a} vs {v}")
avg = ds.get("avg_ticket"); print(f"  avg_ticket report={avg} | gross/tickets={round(gross/tickets,2)} net/tickets={round(netsales/tickets,2)}")
ipt = ds.get("items_per_ticket"); print(f"  items_per_ticket report={ipt} | calc={round(units/tickets,2)}")

# ---- Sales by Item (today, HOU-MTR) ----
m = run("AWANZ Sales by Item", {"from_date":DAY,"to_date":DAY,"boutique":B,"group_by":"Item"})
si = {r["key"]: r for r in rows(m)}
agg=defaultdict(lambda: dict(us=0.0,ur=0.0,gross=0.0,retv=0.0,net=0.0))
for l in lines:
    a=agg[l["item_code"]]; net=float(l["net_amount"] if l["net_amount"] is not None else l["amount"]); q=abs(float(l["qty"]))
    if byn[l["parent"]]["is_return"]: a["ur"]+=q; a["retv"]+=abs(net)
    else: a["us"]+=q; a["gross"]+=net
    a["net"]+=net
bad=0
for code,a in agg.items():
    r=si.get(code)
    if not r: issues.append(f"SalesByItem missing {code}"); bad+=1; continue
    for f,v in (("units_sold",a["us"]),("units_returned",a["ur"]),("gross",a["gross"]),("returns_value",a["retv"]),("net_sales",a["net"])):
        if abs(float(r[f])-v)>0.011: issues.append(f"SalesByItem {code}.{f}: {r[f]} vs {round(v,2)}"); bad+=1
print(f"\nSALES BY ITEM: {len(si)} report rows vs {len(agg)} recomputed items — {bad} field mismatches")

# ---- Sales by Associate ----
m = run("AWANZ Sales by Associate", {"from_date":DAY,"to_date":DAY,"boutique":B})
sa = {r.get("associate"): r for r in rows(m)}
A=defaultdict(lambda: dict(net=0.0,tickets=0,rets=0,wc=0))
for r in inv:
    a=A[r["maison_associate"]]; a["net"]+=float(r["net_total"])
    if r["is_return"]: a["rets"]+=1
    else:
        a["tickets"]+=1
        if r["customer"] and r["customer"] not in walk: a["wc"]+=1
print("SALES BY ASSOCIATE:")
for k,v in A.items():
    r=sa.get(k)
    print(f"  {str(k):40} report={json.dumps({x:r[x] for x in r if x in ('net_sales','tickets','returns','avg_ticket','with_client','clients_attached')}, default=str) if r else None} calc net={round(v['net'],2)} tickets={v['tickets']} returns={v['rets']} wc={v['wc']}")
    if r:
        if abs(float(r.get("net_sales",0))-v["net"])>0.011: issues.append(f"SalesByAssociate {k}.net_sales: {r.get('net_sales')} vs {round(v['net'],2)}")
        if int(r.get("tickets",0))!=v["tickets"]: issues.append(f"SalesByAssociate {k}.tickets: {r.get('tickets')} vs {v['tickets']}")

# ---- Hourly heatmap ----
m = run("AWANZ Hourly Sales Heatmap", {"from_date":DAY,"to_date":DAY,"boutique":B})
hm = rows(m)
H=defaultdict(float)
for r in inv: H[int(str(r["posting_time"]).split(":")[0])] += float(r["grand_total"])
print(f"\nHOURLY HEATMAP: {len(hm)} rows; sample={json.dumps(hm[0], default=str)[:260] if hm else None}")
print("  calc by hour (grand_total):", {k:round(v,2) for k,v in sorted(H.items())})

# ---- Returns ----
m = run("AWANZ Returns", {"from_date":DAY,"to_date":DAY,"boutique":B})
rr = rows(m)
print(f"\nRETURNS: {len(rr)} rows; total value={round(sum(float(x.get('returns_value',x.get('value',0)) or 0) for x in rr),2)} | calc returns count={rets} value={round(retv,2)}")
for x in rr: print("   ", json.dumps(x, default=str)[:200])

# ---- Client Purchases RFM ----
m = run("AWANZ Client Purchases", {"from_date":"2026-05-22","to_date":DAY,"boutique":B})
cp = rows(m)
print(f"\nCLIENT PURCHASES: {len(cp)} rows; first={json.dumps(cp[0], default=str)[:300] if cp else None}")
if cp:
    c0=cp[0]
    ci = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"customer":c0.get("customer"),"maison_boutique":B,"posting_date":("between",["2026-05-22",DAY])}, fields=["name","grand_total","net_total","posting_date","is_return"], limit=200)
    print(f"   recompute for {c0.get('customer')}: invoices={len([x for x in ci if not x['is_return']])} net_total_sum={round(sum(float(x['net_total']) for x in ci),2)} grand_sum={round(sum(float(x['grand_total']) for x in ci),2)} last={max(str(x['posting_date']) for x in ci)}")
print(f"\n{len(issues)} discrepancies"); [print('  !',i) for i in issues[:25]]
json.dump({"issues":issues}, open("/home/claude/awanz/e2e/qa/results-d9.json","w"), indent=1, default=str)
