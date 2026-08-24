#!/usr/bin/env python3
"""D7 — recompute hr.employee_performance + commission for HOU-MTR (last 30 d) and check avg-ticket bases."""
import json
from collections import defaultdict
from datetime import date, timedelta
import dq

TODAY=date(2026,8,23); FROM=TODAY-timedelta(days=30)
B="HOU-MTR"
perf = dq.call("maison_pos.api.hr.employee_performance", {"boutique":B,"from_date":str(FROM),"to_date":str(TODAY)})["message"]
inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"maison_boutique":B,"posting_date":("between",[str(FROM),str(TODAY)])},
    fields=["name","maison_associate","customer","base_net_total","grand_total","is_return","return_against"], limit=5000)
walk = set(r["customer"] for r in dq.get_list("POS Profile", fields=["customer"], limit=50))
orig = [i["return_against"] for i in inv if i["is_return"] and i["return_against"]]
seller = {}
if orig:
    for i in range(0,len(orig),80):
        for r in dq.get_list("Sales Invoice", filters={"name":("in",orig[i:i+80])}, fields=["name","maison_associate"], limit=500):
            seller[r["name"]]=r["maison_associate"]
S=defaultdict(lambda: dict(sales=0.0,gross=0.0,tickets=0,returns=0,ret_amt=0.0,wc=0))
BT=dict(sales=0.0,tickets=0,gross=0.0)
for x in inv:
    a = seller.get(x["return_against"]) if (x["is_return"] and seller.get(x["return_against"])) else x["maison_associate"]
    n=float(x["base_net_total"] or 0)
    BT["sales"]+=n
    if not x["is_return"]: BT["tickets"]+=1; BT["gross"]+=n
    if not a: continue
    s=S[a]; s["sales"]+=n
    if x["is_return"]: s["returns"]+=1; s["ret_amt"]+=abs(n)
    else:
        s["gross"]+=n; s["tickets"]+=1
        if x["customer"] and x["customer"] not in walk: s["wc"]+=1
print(f"{B} 30 d: {len(inv)} invoices, {len(perf)} associates")
bad=[]
for p in perf:
    c=S[p["associate"]]
    for f,a,cc in [("sales",p["sales"],round(c["sales"],2)),("gross_sales",p["gross_sales"],round(c["gross"],2)),
                   ("tickets",p["tickets"],c["tickets"]),("returns",p["returns"],c["returns"]),
                   ("returns_amount",p["returns_amount"],round(c["ret_amt"],2)),("with_client",p["with_client"],c["wc"])]:
        if abs(float(a)-float(cc))>0.011: bad.append(f"{p['associate']}.{f}: API={a} calc={cc}")
    avg_gross = round(c["gross"]/c["tickets"],2) if c["tickets"] else 0
    avg_net   = round(c["sales"]/c["tickets"],2) if c["tickets"] else 0
    print(f"  {p['associate_name']:16} sales={p['sales']:9.2f} tickets={p['tickets']:4d} avg_ticket(API)={p['avg_ticket']:7.2f} "
          f"[gross basis={avg_gross:7.2f} net basis={avg_net:7.2f}] vs_boutique={p['avg_ticket_vs_boutique']} conv={p['conversion']} comm={p['commission']}")
bt_net = round(BT["sales"]/BT["tickets"],2); bt_gross = round(BT["gross"]/BT["tickets"],2)
print(f"\nboutique_avg_ticket API={perf[0]['boutique_avg_ticket']}  net basis(calc)={bt_net}  gross basis(calc)={bt_gross}")
print(f"  -> associate avg_ticket is on the GROSS basis; boutique_avg_ticket is on the NET basis.")
for p in perf:
    if p["avg_ticket_vs_boutique"]:
        fair = round(p["avg_ticket"]/bt_gross,3)
        print(f"  {p['associate_name']:16} vs_boutique API={p['avg_ticket_vs_boutique']:.3f}  same-basis={fair:.3f}  (inflated by {round((p['avg_ticket_vs_boutique']/fair-1)*100,1)}%)")
print(f"\n{len(bad)} field discrepancies"); [print('  !',b) for b in bad[:20]]

# ---- commission statement ----
cs = dq.call("maison_pos.api.hr.commission_statement", {"from_date":str(FROM),"to_date":str(TODAY),"boutique":B})["message"]
print("\ncommission_statement keys:", list(cs.keys()) if isinstance(cs,dict) else type(cs))
ent = dq.get_list("AWANZ Commission Entry", filters={"boutique":B,"posting_date":("between",[str(FROM),str(TODAY)])},
       fields=["associate","commission_amount","base_amount","is_reversal","rate_percent"], limit=5000)
tot=defaultdict(float); base=defaultdict(float)
for e in ent: tot[e["associate"]]+=float(e["commission_amount"] or 0); base[e["associate"]]+=float(e["base_amount"] or 0)
print(f"raw AWANZ Commission Entry rows: {len(ent)}")
rows = cs.get("rows") or cs.get("associates") or []
for r in rows:
    a=r.get("associate"); ok = abs(float(r.get("commission",0))-tot[a])<0.011
    print(f"  {a:38} statement={r.get('commission')} recompute={round(tot[a],2)} entries={r.get('entries')} {'OK' if ok else '*** MISMATCH ***'}")
    if not ok: bad.append(f"commission {a}: {r.get('commission')} vs {round(tot[a],2)}")
# cross-check commission in employee_performance
for p in perf:
    ok=abs(float(p["commission"])-tot[p["associate"]])<0.011
    if not ok: bad.append(f"perf.commission {p['associate']}: API={p['commission']} entries={round(tot[p['associate']],2)}")
print(f"\ntotal discrepancies incl. commission: {len(bad)}")
json.dump({"bad":bad,"perf":perf,"bt_net":bt_net,"bt_gross":bt_gross}, open("/home/claude/awanz/e2e/qa/results-d7.json","w"), indent=1, default=str)
