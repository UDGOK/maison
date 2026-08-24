#!/usr/bin/env python3
"""D4 — top_products (by net + by units) and matrix, recomputed from the trend table itself + raw lines."""
import json, time
from collections import defaultdict
import dq

out={}
for by in ("net","units"):
    t0=time.time(); tp = dq.call("maison_pos.api.dashboard.top_products", {"boutique":"all","by":by,"period":"7d","n":10})["message"]; ms=(time.time()-t0)*1000
    out[by]=tp
    print(f"top_products by={by}: {ms:.0f} ms, boutiques={len(tp['boutiques'])}, matrix cells={len(tp['matrix'])}, groups={len(tp['groups'])}")
    print("  boutiques:", tp["boutiques"])
    bad=[]
    for b,rows in tp["top"].items():
        key = "net" if by=="net" else "units"
        vals=[float(r[key]) for r in rows]
        if vals != sorted(vals, reverse=True): bad.append(f"{b} not descending by {key}: {vals}")
        ranks=[r["rank" if by=="net" else "rank_units"] for r in rows]
        if ranks != sorted(ranks): bad.append(f"{b} rank order broken: {ranks}")
        if len(rows)>10: bad.append(f"{b} returned {len(rows)} > n=10")
    print(f"  ordering issues: {bad if bad else 'none'}")
    # share_pct check for one boutique
    b0 = tp["boutiques"][0]
    tot = tp["boutique_net"][b0]
    for r in tp["top"][b0][:3]:
        exp = round(float(r["net"])/tot*100,2) if tot else 0
        print(f"    {b0} {r['item_code']:9} net={r['net']:9.2f} share_pct API={r['share_pct']:6.2f} calc(vs boutique_net {tot:.2f})={exp:6.2f}")

# --- independent: top 10 by net for one store straight from Sales Invoice Item over the 7d window ---
from datetime import date, timedelta
TODAY=date(2026,8,23); C7=TODAY-timedelta(days=6)
B="HOU-MTR"
inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"maison_boutique":B,"posting_date":("between",[str(C7),str(TODAY)])},
                  fields=["name"], limit=5000)
names=[r["name"] for r in inv]; lines=[]
for i in range(0,len(names),120):
    lines += dq.get_list("Sales Invoice Item", filters={"parent":("in",names[i:i+120]),"parenttype":"Sales Invoice"},
                         fields=["item_code","item_name","qty","amount"], limit=20000, parent="Sales Invoice")
agg=defaultdict(lambda:[0.0,0.0])
for L in lines:
    agg[L["item_code"]][0]+=float(L["qty"] or 0); agg[L["item_code"]][1]+=float(L["amount"] or 0)
by_net=sorted(agg.items(), key=lambda kv:(-kv[1][1],-kv[1][0],kv[0]))[:10]
api_net = out["net"]["top"].get(B,[])
print(f"\n{B} top-10 by net — API vs raw recompute ({len(inv)} invoices, {len(lines)} lines in 7d):")
ok=True
for i,((code,(u,n)),r) in enumerate(zip(by_net, api_net), 1):
    m = "OK" if (code==r["item_code"] and abs(n-float(r["net"]))<0.011 and abs(u-float(r["units"]))<0.011) else "*** MISMATCH ***"
    if m!="OK": ok=False
    print(f"  {i:2}. calc {code:9} net={n:9.2f} u={u:5.1f} | API {r['item_code']:9} net={float(r['net']):9.2f} u={float(r['units']):5.1f}  {m}")
by_units=sorted(agg.items(), key=lambda kv:(-kv[1][0],-kv[1][1],kv[0]))[:10]
api_u = out["units"]["top"].get(B,[])
print(f"{B} top-10 by units — API vs raw:")
for i,((code,(u,n)),r) in enumerate(zip(by_units, api_u), 1):
    m = "OK" if code==r["item_code"] else "*** MISMATCH ***"
    if m!="OK": ok=False
    print(f"  {i:2}. calc {code:9} u={u:5.1f} | API {r['item_code']:9} u={float(r['units']):5.1f}  {m}")
# boutique_net check
tot_calc = sum(v[1] for v in agg.values())
print(f"\nboutique_net[{B}] API={out['net']['boutique_net'][B]:.2f} calc(sum of 7d lines)={tot_calc:.2f}")
# matrix check for one group
mx = {(m["item_group"],m["boutique"]):m for m in out["net"]["matrix"]}
grp_calc=defaultdict(lambda:[0.0,0.0])
codes=list(agg)
items = dq.get_list("Item", filters={"name":("in",codes)}, fields=["name","item_group"], limit=500)
g_of={it["name"]:it["item_group"] for it in items}
for code,(u,n) in agg.items(): grp_calc[g_of.get(code)][0]+=n; grp_calc[g_of.get(code)][1]+=u
print(f"matrix {B} — group revenue API vs calc:")
mism=0
for g,(n,u) in sorted(grp_calc.items()):
    cell = mx.get((g,B))
    a = float(cell["revenue"]) if cell else None
    st = "OK" if (a is not None and abs(a-n)<0.011) else "*** MISMATCH ***"
    if st!="OK": mism+=1
    print(f"   {str(g):24} API={a} calc={n:.2f} units API={cell['units'] if cell else None} calc={u:.1f}  {st}")
print("matrix mismatches:", mism)
json.dump({"ok":ok,"matrix_mismatch":mism}, open("/home/claude/maison/e2e/qa/results-d4.json","w"), indent=1, default=str)
