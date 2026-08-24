#!/usr/bin/env python3
"""D1 — independently recompute live_summary from Sales Invoice rows and compare."""
import json, sys, time
from collections import defaultdict
import dq

DAY = sys.argv[1] if len(sys.argv) > 1 else "2026-08-23"
LW  = "2026-08-16"

t0 = time.time()
live = dq.call("maison_pos.api.dashboard.live_summary", {"nocache": 1, "date": DAY})["message"]
t_live = time.time() - t0

# --- raw rows ---
inv = dq.get_list("Sales Invoice",
    filters={"docstatus": 1, "is_pos": 1, "posting_date": DAY},
    fields=["name","maison_boutique","grand_total","is_return","posting_time","customer","change_amount","loyalty_amount"],
    limit=2000, order_by="name asc")
lw_inv = dq.get_list("Sales Invoice",
    filters={"docstatus": 1, "is_pos": 1, "posting_date": LW},
    fields=["name","maison_boutique","grand_total","is_return"], limit=5000, order_by="name asc")
pays = []
names = [r["name"] for r in inv]
for i in range(0, len(names), 60):
    chunk = names[i:i+60]
    pays += dq.get_list("Sales Invoice Payment", filters={"parent": ("in", chunk), "parenttype":"Sales Invoice"},
        fields=["parent","mode_of_payment","amount"], limit=5000, parent="Sales Invoice")

walkins = [r["customer"] for r in dq.get_list("POS Profile", fields=["customer"], limit=100)]
stores = [b["boutique"] for b in live["by_boutique"]]

def rc(x): return round(x + 1e-9, 2)

per = defaultdict(lambda: dict(net=0.0, invoices=0, returns=0, returns_value=0.0, cash=0.0, card=0.0,
                               change=0.0, with_customer=0, by_hour=[0.0]*24, loyalty=0.0))
for r in inv:
    b = r["maison_boutique"]
    if b not in stores:  # HOU-WH etc
        continue
    p = per[b]
    g = float(r["grand_total"] or 0)
    p["net"] += g
    if r["is_return"]:
        p["returns"] += 1
        p["returns_value"] += abs(g)
    else:
        p["invoices"] += 1
        p["change"] += float(r["change_amount"] or 0)
        if r["customer"] and r["customer"] not in walkins:
            p["with_customer"] += 1
    p["loyalty"] += float(r["loyalty_amount"] or 0)
    hr = int(str(r["posting_time"]).split(":")[0])
    p["by_hour"][hr] += g

paid_by_inv = defaultdict(lambda: defaultdict(float))
for pr in pays:
    paid_by_inv[pr["parent"]][(pr["mode_of_payment"] or "").lower()] += float(pr["amount"] or 0)
inv_b = {r["name"]: r["maison_boutique"] for r in inv}
for name, modes in paid_by_inv.items():
    b = inv_b.get(name)
    if b not in stores: continue
    for m, amt in modes.items():
        if m == "cash": per[b]["cash"] += amt
        else: per[b]["card"] += amt
for b in per: per[b]["cash"] -= per[b]["change"]

lw_by_b = defaultdict(float)
for r in lw_inv:
    if r["maison_boutique"] in stores:
        lw_by_b[r["maison_boutique"]] += float(r["grand_total"] or 0)

# --- compare per boutique ---
issues = []
print(f"live_summary uncached: {t_live*1000:.0f} ms; {len(inv)} invoices today; walkins={walkins[:2]}...")
print(f"{'store':9} {'net API':>10} {'net calc':>10} {'inv':>4}/{'c':>3} {'ret':>4}/{'c':>3} {'cash API':>10} {'cash calc':>10} {'card API':>10} {'card calc':>10} {'avgAPI':>8} {'vsLW API':>9} {'vsLW calc':>9}")
for row in live["by_boutique"]:
    b = row["boutique"]; p = per[b]
    lwn = lw_by_b[b]
    vslw = round((p["net"] - lwn)/lwn*100.0, 1) if lwn > 0 else None
    avg_api = row["avg_ticket"]
    print(f"{b:9} {row['net']:10.2f} {p['net']:10.2f} {row['invoices']:4d}/{p['invoices']:3d} {row['returns']:4d}/{p['returns']:3d} "
          f"{row['cash']:10.2f} {p['cash']:10.2f} {row['card']:10.2f} {p['card']:10.2f} {avg_api:8.2f} "
          f"{str(row['vs_last_week_pct']):>9} {str(vslw):>9}")
    def chk(field, a, c, tol=0.011):
        if isinstance(a,(int,float)) and isinstance(c,(int,float)):
            if abs(a-c) > tol: issues.append(f"{b}.{field}: API={a} calc={c}")
        elif a != c: issues.append(f"{b}.{field}: API={a} calc={c}")
    chk("net", rc(row["net"]), rc(p["net"]))
    chk("invoices", row["invoices"], p["invoices"], 0)
    chk("returns", row["returns"], p["returns"], 0)
    chk("returns_value", rc(row["returns_value"]), rc(p["returns_value"]))
    chk("cash", rc(row["cash"]), rc(p["cash"]))
    chk("card", rc(row["card"]), rc(p["card"]))
    chk("last_week_net", rc(row["last_week_net"]), rc(lwn))
    chk("vs_last_week_pct", row["vs_last_week_pct"], vslw, 0.051)
    chk("with_customer", row["with_customer"], p["with_customer"], 0)
    if row["invoices"]:
        chk("avg_ticket", rc(row["avg_ticket"]), rc(row["net"]/row["invoices"]))
    for h in range(24):
        chk(f"by_hour[{h}]", rc(row["by_hour"][h]), rc(p["by_hour"][h]))

T = live["totals"]
tot = dict(net=sum(per[b]["net"] for b in stores), invoices=sum(per[b]["invoices"] for b in stores),
           returns=sum(per[b]["returns"] for b in stores), returns_value=sum(per[b]["returns_value"] for b in stores),
           cash=sum(per[b]["cash"] for b in stores), card=sum(per[b]["card"] for b in stores),
           last_week_net=sum(lw_by_b[b] for b in stores))
print("\nTOTALS  API vs calc")
for k in ("net","invoices","returns","returns_value","cash","card","last_week_net"):
    a, c = T[k], tot[k]
    ok = abs(a-c) <= 0.011
    print(f"  {k:15} API={a:12.2f}  calc={c:12.2f}  {'OK' if ok else '*** MISMATCH ***'}")
    if not ok: issues.append(f"totals.{k}: API={a} calc={c}")
print(f"  {'avg_ticket':15} API={T['avg_ticket']:12.4f}  calc(net/inv)={tot['net']/tot['invoices'] if tot['invoices'] else 0:12.4f}")
sales_only = sum(float(r['grand_total']) for r in inv if not r['is_return'] and r['maison_boutique'] in stores)
print(f"     -> sales-only avg ticket would be {sales_only/tot['invoices']:.4f} (sales {sales_only:.2f} / {tot['invoices']})")
vslw = round((tot["net"]-tot["last_week_net"])/tot["last_week_net"]*100,1) if tot["last_week_net"]>0 else None
print(f"  {'vs_last_week':15} API={T['vs_last_week_pct']}  calc={vslw}")
print(f"  cash+card = {tot['cash']+tot['card']:.2f} vs net {tot['net']:.2f}  (loyalty redeemed today {sum(per[b]['loyalty'] for b in stores):.2f})")
print(f"\nHOU-WH in by_boutique? {'HOU-WH' in [b['boutique'] for b in live['by_boutique']]}; boutiques={T['boutiques']}")
print(f"\n{len(issues)} discrepancies")
for i in issues[:40]: print("  !", i)
json.dump({"issues": issues, "live": live, "calc_totals": tot, "t_live_ms": t_live*1000},
          open("/home/claude/awanz/e2e/qa/results-d1.json","w"), indent=1, default=str)
