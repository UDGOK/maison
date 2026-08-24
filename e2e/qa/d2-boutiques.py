#!/usr/bin/env python3
"""D2 — recompute boutiques_table (WTD/MTD, vs LW, conversion, returns %, stock value, sparkline)."""
import json, time
from collections import defaultdict
from datetime import date, timedelta
import dq

DAY = date(2026, 8, 23)
t0 = time.time(); bt = dq.call("maison_pos.api.dashboard.boutiques_table")["message"]; t_bt = time.time()-t0
rows = bt["rows"]
stores = [r["boutique"] for r in rows]
week_start = DAY - timedelta(days=DAY.weekday())     # Monday
month_start = DAY.replace(day=1)
lw_start, lw_end = week_start - timedelta(days=7), DAY - timedelta(days=7)
spark_from = DAY - timedelta(days=13)
print(f"boutiques_table {t_bt*1000:.0f} ms · rows={len(rows)} · week_start(API)={bt['week_start']} calc={week_start} · month_start(API)={bt['month_start']} calc={month_start}")

lo = str(min(month_start, lw_start, spark_from))
inv = dq.get_list("Sales Invoice", filters={"docstatus":1,"is_pos":1,"posting_date":("between",[lo,str(DAY)])},
    fields=["name","maison_boutique","grand_total","is_return","posting_date","customer"], limit=20000, order_by="name asc")
print("invoices in window:", len(inv))
walkins = set(r["customer"] for r in dq.get_list("POS Profile", fields=["customer"], limit=100))

def agg(f, t):
    out = defaultdict(lambda: dict(net=0.0, tickets=0, returns=0, wc=0))
    for r in inv:
        d = str(r["posting_date"])
        if f <= d <= t:
            o = out[r["maison_boutique"]]
            o["net"] += float(r["grand_total"] or 0)
            if r["is_return"]: o["returns"] += 1
            else:
                o["tickets"] += 1
                if r["customer"] and r["customer"] not in walkins: o["wc"] += 1
    return out
wtd, lw, mtd = agg(str(week_start), str(DAY)), agg(str(lw_start), str(lw_end)), agg(str(month_start), str(DAY))
spark = defaultdict(lambda: [0.0]*14)
for r in inv:
    idx = (date.fromisoformat(str(r["posting_date"])) - spark_from).days
    if 0 <= idx < 14: spark[r["maison_boutique"]][idx] += float(r["grand_total"] or 0)

# stock value via Bin
whs = {b["name"]: b["warehouse"] for b in dq.get_list("Maison Boutique", fields=["name","warehouse"], limit=50)}
bins = dq.get_list("Bin", filters={"warehouse":("in",[w for w in whs.values() if w])}, fields=["warehouse","stock_value"], limit=20000)
sv = defaultdict(float)
for b in bins: sv[b["warehouse"]] += float(b["stock_value"] or 0)

issues = []
def chk(b, f, a, c, tol=0.011):
    if a is None or c is None:
        if a != c: issues.append(f"{b}.{f}: API={a} calc={c}")
    elif abs(a-c) > tol: issues.append(f"{b}.{f}: API={a} calc={c}")
print(f"\n{'store':9} {'wtd API':>10} {'wtd calc':>10} {'mtd API':>10} {'mtd calc':>10} {'wtdVsLW':>8}/{'calc':>8} {'mtdTick':>7} {'mtdAvg':>8}/{'calc':>8} {'conv':>6}/{'calc':>6} {'ret%':>6}/{'calc':>6} {'stockV':>11}/{'calc':>11}")
for r in rows:
    b = r["boutique"]; w, l, m = wtd[b], lw[b], mtd[b]
    wvl = round((w["net"]-l["net"])/l["net"]*100,1) if l["net"] > 0 else None
    mavg = m["net"]/m["tickets"] if m["tickets"] else 0.0
    mconv = round(m["wc"]/m["tickets"],3) if m["tickets"] else 0.0
    rpct = round(m["returns"]/(m["tickets"]+m["returns"])*100,1) if (m["tickets"]+m["returns"]) else 0.0
    csv = sv.get(whs.get(b), 0.0)
    print(f"{b:9} {r['wtd_net']:10.2f} {w['net']:10.2f} {r['mtd_net']:10.2f} {m['net']:10.2f} {str(r['wtd_vs_lw_pct']):>8}/{str(wvl):>8} {r['mtd_tickets']:7d} {r['mtd_avg_ticket']:8.2f}/{mavg:8.2f} {r['mtd_conversion']:6.3f}/{mconv:6.3f} {r['returns_pct']:6.1f}/{rpct:6.1f} {r['stock_value']:11.2f}/{csv:11.2f}")
    chk(b,"wtd_net", round(r["wtd_net"],2), round(w["net"],2))
    chk(b,"mtd_net", round(r["mtd_net"],2), round(m["net"],2))
    chk(b,"wtd_vs_lw_pct", r["wtd_vs_lw_pct"], wvl, 0.051)
    chk(b,"mtd_tickets", r["mtd_tickets"], m["tickets"], 0)
    chk(b,"mtd_avg_ticket", round(r["mtd_avg_ticket"],2), round(mavg,2))
    chk(b,"mtd_conversion", r["mtd_conversion"], mconv, 0.0011)
    chk(b,"returns_pct", r["returns_pct"], rpct, 0.051)
    chk(b,"stock_value", round(r["stock_value"],2), round(csv,2))
    if len(r["sparkline"]) != 14: issues.append(f"{b}.sparkline len={len(r['sparkline'])}")
    for i in range(14):
        chk(b,f"spark[{i}]", round(r["sparkline"][i],2), round(spark[b][i],2))
print(f"\n{len(issues)} discrepancies")
for i in issues[:40]: print("  !", i)
json.dump({"issues":issues,"t_ms":t_bt*1000,"rows":rows}, open("/home/claude/maison/e2e/qa/results-d2.json","w"), indent=1, default=str)
