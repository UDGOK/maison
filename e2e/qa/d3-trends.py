#!/usr/bin/env python3
"""D3 — recompute Maison Product Trend rows (7d) from Sales Invoice Item + Bin and compare to product_trends()."""
import json, time
from collections import defaultdict
from datetime import date, timedelta
import dq

TODAY = date(2026, 8, 23)
d = {k: TODAY - timedelta(days=v) for k, v in {"c7":6,"p7":13,"c28":27,"p28":55,"b112":111}.items()}
print("windows:", {k: str(v) for k,v in d.items()})

t0=time.time(); pt = dq.call("maison_pos.api.dashboard.product_trends", {"period":"7d","limit":500})["message"]; t_pt=time.time()-t0
print(f"product_trends 7d chain: {t_pt*1000:.0f} ms · total={pt['total']} rows_returned={len(pt['rows'])} computed_at={pt['computed_at']} last_run={pt.get('last_run')}")

# raw sales lines
inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"posting_date":("between",[str(d['b112']),str(TODAY)])},
                  fields=["name","maison_boutique","posting_date"], limit=20000, order_by="name asc")
print("invoices in 112d:", len(inv))
meta = {r["name"]: r for r in inv}
names = list(meta)
lines = []
for i in range(0, len(names), 120):
    lines += dq.get_list("Sales Invoice Item", filters={"parent":("in",names[i:i+120]),"parenttype":"Sales Invoice"},
                         fields=["parent","item_code","qty","amount"], limit=20000, parent="Sales Invoice")
print("invoice lines:", len(lines))
stores = sorted({r["maison_boutique"] for r in inv if r["maison_boutique"]})

acc = defaultdict(lambda: defaultdict(float))
for L in lines:
    m = meta.get(L["parent"])
    if not m: continue
    pd = date.fromisoformat(str(m["posting_date"])); b = m["maison_boutique"]
    k = (L["item_code"], b); q = float(L["qty"] or 0); a = float(L["amount"] or 0)
    A = acc[k]
    if pd >= d["c7"]: A["u7"] += q; A["n7"] += a
    if d["p7"] <= pd < d["c7"]: A["u7p"] += q; A["n7p"] += a
    if pd >= d["c28"]: A["u28"] += q; A["n28"] += a
    if d["p28"] <= pd < d["c28"]: A["u28p"] += q; A["n28p"] += a
    A["u112"] += q

# stock
whs = {b["name"]: b["warehouse"] for b in dq.get_list("Maison Boutique", fields=["name","warehouse","enabled"], limit=50)}
by_wh = {v:k for k,v in whs.items() if v}
bins = dq.get_list("Bin", filters={"warehouse":("in",list(by_wh))}, fields=["item_code","warehouse","actual_qty"], limit=20000)
stock = {}
for b in bins: stock[(b["item_code"], by_wh[b["warehouse"]])] = float(b["actual_qty"] or 0)

# chain-level fold
chain = defaultdict(lambda: defaultdict(float)); chain_stock = defaultdict(float); stores7 = defaultdict(set)
retail = set(stores) - {"HOU-WH"}
for (code,b),A in acc.items():
    if b not in retail: continue
    for f,v in A.items(): chain[code][f] += v
    if A["u7"] > 0: stores7[code].add(b)
for (code,b),q in stock.items():
    if b in retail: chain_stock[code] += q

def pct(c,p): return None if p<=0 else round((c-p)/p*100.0,1)
def badge(u,up,ub,uo):
    if u>0 and up==0 and uo==0: return "New"
    dp, db = pct(u,up), pct(u,ub)
    if dp is not None:
        if dp>=25 and u>=2 and (db is None or db>=25): return "Trending up"
        if dp<=-25 and up>=2: return "Cooling"
    elif u>=2 and db is not None and db>=25: return "Trending up"
    if u==0 and up>=2: return "Cooling"
    return "Steady"

calc = {}
for code,A in chain.items():
    u,up,u4,oh = A["u7"],A["u7p"],A["u28"], chain_stock.get(code,0.0)
    base = round(u4/4.0,3); per_day = u/7
    calc[code] = dict(units=u, units_prev=up, units_baseline=base, net=round(A["n7"],2), net_prev=round(A["n7p"],2),
        velocity=round(per_day*7,3), delta_pct=pct(u,up), baseline_delta_pct=pct(u,base),
        badge=badge(u,up,base,max(0.0,u4-u)), on_hand=oh,
        sell_through=round(u/(u+oh),4) if (u+oh)>0 else 0.0,
        days_on_hand=round(oh/per_day,1) if per_day>0 else None,
        store_count=len(stores7[code]))
calc = {k:v for k,v in calc.items() if not (v["units"]==0 and v["units_prev"]==0 and chain[k]["u28"]==0)}

issues=[]; checked=0
for r in pt["rows"]:
    c = calc.get(r["item_code"])
    if c is None: issues.append(f"{r['item_code']}: not in recompute"); continue
    checked+=1
    for f in ("units","units_prev","units_baseline","net","net_prev","velocity","on_hand","sell_through","store_count"):
        a,cc = r[f], c[f]
        if abs(float(a)-float(cc)) > 0.011: issues.append(f"{r['item_code']}.{f}: API={a} calc={cc}")
    for f in ("delta_pct","baseline_delta_pct","days_on_hand"):
        a,cc = r[f], c[f]
        if a is None or cc is None:
            if a != cc: issues.append(f"{r['item_code']}.{f}: API={a} calc={cc}")
        elif abs(float(a)-float(cc)) > 0.051: issues.append(f"{r['item_code']}.{f}: API={a} calc={cc}")
    if r["badge"] != c["badge"]: issues.append(f"{r['item_code']}.badge: API={r['badge']} calc={c['badge']}")
print(f"\nchecked {checked} chain 7d rows; recompute produced {len(calc)} chain rows; table total={pt['total']}")
print(f"badges API: {pt['badges']}")
cb = defaultdict(int)
for v in calc.values(): cb[v["badge"]] += 1
print(f"badges calc: {dict(cb)}")
print(f"\n{len(issues)} discrepancies")
for i in issues[:50]: print("  !", i)
# top 5 sample
print("\nsample (top 5 by API order):")
for r in pt["rows"][:5]:
    print(f"  {r['item_code']:10} {r['item_name'][:34]:34} u={r['units']:6} prev={r['units_prev']:6} d%={r['delta_pct']} badge={r['badge']:12} onhand={r['on_hand']:7} ST={r['sell_through']} DOH={r['days_on_hand']} stores={r['store_count']}")
json.dump({"issues":issues,"t_ms":t_pt*1000,"total":pt["total"],"computed_at":pt["computed_at"],"last_run":pt.get("last_run")},
          open("/home/claude/maison/e2e/qa/results-d3.json","w"), indent=1, default=str)
