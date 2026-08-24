#!/usr/bin/env python3
"""D5 — hand-compute the Sales Tax Summary for HOU-MTR on 2026-08-23 and compare to the report AND
   to the tax actually booked on the invoices."""
import json
from collections import defaultdict
import dq

DAY="2026-08-23"; B="HOU-MTR"
rep = dq.call("frappe.desk.query_report.run", {"report_name":"AWANZ Sales Tax Summary",
      "filters": json.dumps({"from_date":DAY,"to_date":DAY,"boutique":B}), "ignore_prepared_report":1})["message"]
row = rep["result"][0]
print("REPORT row:", json.dumps(row, indent=1))

inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"maison_boutique":B,"posting_date":DAY},
    fields=["name","is_return","net_total","total_taxes_and_charges","grand_total","taxes_and_charges","rounding_adjustment"], limit=500)
names=[r["name"] for r in inv]; lines=[]
for i in range(0,len(names),80):
    lines += dq.get_list("Sales Invoice Item", filters={"parent":("in",names[i:i+80]),"parenttype":"Sales Invoice"},
        fields=["parent","item_code","qty","amount","net_amount"], limit=5000, parent="Sales Invoice")
codes=sorted({L["item_code"] for L in lines})
items = {it["name"]: it for it in dq.get_list("Item", filters={"name":("in",codes)}, fields=["name","maison_taxable"], limit=500)}
byname={r["name"]:r for r in inv}
tmpl = row["tax_template"]
tc = dq.get_list("Sales Taxes and Charges", filters={"parent":tmpl,"parenttype":"Sales Taxes and Charges Template","charge_type":"On Net Total"},
     fields=["rate","description","account_head"], limit=20, parent="Sales Taxes and Charges Template")
rate = sum(float(t["rate"]) for t in tc)
print(f"\ntax template {tmpl}: rows={[(t['description'],t['rate']) for t in tc]} -> combined rate {rate}%")

g=r_=tax_s=tax_r=taxable=nontax=0.0
tickets=set(); rets=set()
for L in lines:
    p=byname[L["parent"]]; net=float(L["net_amount"] if L["net_amount"] is not None else L["amount"])
    is_tax = 1 if items.get(L["item_code"],{}).get("maison_taxable") in (1,None) else 0
    t = round(net*rate/100,2) if is_tax else 0.0
    if p["is_return"]:
        rets.add(L["parent"]); r_ += abs(net); tax_r += abs(t)
    else:
        tickets.add(L["parent"]); g += net; tax_s += t
    if is_tax: taxable += net
    else: nontax += net
calc = dict(gross_sales=round(g,2), returns_value=round(r_,2), taxable_sales=round(taxable,2),
            non_taxable_sales=round(nontax,2), net_sales=round(taxable+nontax,2),
            tax_sales=round(tax_s,2), tax_returns=round(tax_r,2), tax_collected=round(tax_s-tax_r,2),
            tickets=len(tickets), returns=len(rets))
print("\nHAND-COMPUTED (line net_amount x rate, per line rounded to cents):")
bad=[]
for k,v in calc.items():
    a=row[k]; ok = (abs(float(a)-float(v))<=0.011)
    print(f"  {k:20} report={a:>10}  hand={v:>10}  {'OK' if ok else '*** MISMATCH ***'}")
    if not ok: bad.append(k)

# --- cross-check against tax actually BOOKED on the invoices ---
booked_s=sum(float(r["total_taxes_and_charges"] or 0) for r in inv if not r["is_return"])
booked_r=sum(float(r["total_taxes_and_charges"] or 0) for r in inv if r["is_return"])
net_s=sum(float(r["net_total"] or 0) for r in inv if not r["is_return"])
net_r=sum(float(r["net_total"] or 0) for r in inv if r["is_return"])
gt=sum(float(r["grand_total"] or 0) for r in inv)
print(f"\nBOOKED ON INVOICES ({len(inv)} invoices): net_total sales={net_s:.2f} returns={net_r:.2f} | taxes sales={booked_s:.2f} returns={booked_r:.2f} net tax={booked_s+booked_r:.2f}")
print(f"  report tax_collected = {row['tax_collected']}   booked net tax = {round(booked_s+booked_r,2)}   diff = {round(row['tax_collected']-(booked_s+booked_r),2)}")
print(f"  report net_sales     = {row['net_sales']}   booked net_total  = {round(net_s+net_r,2)}   diff = {round(row['net_sales']-(net_s+net_r),2)}")
print(f"  grand_total sum      = {gt:.2f}  (= net {round(net_s+net_r,2)} + tax {round(booked_s+booked_r,2)} = {round(net_s+net_r+booked_s+booked_r,2)})")
print(f"  live_summary net for {B} should equal {gt:.2f}")
tmpls = sorted({r["taxes_and_charges"] for r in inv})
print(f"  distinct tax templates on today's {B} invoices: {tmpls}")
json.dump({"report_row":row,"hand":calc,"mismatch_fields":bad,"booked_tax":round(booked_s+booked_r,2)},
          open("/home/claude/awanz/e2e/qa/results-d5.json","w"), indent=1, default=str)
