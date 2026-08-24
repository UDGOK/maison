#!/usr/bin/env python3
"""D6 — run every AWANZ Script Report with several filter combinations."""
import json, time
import dq

REPORTS = ["AWANZ Sales Tax Summary","AWANZ Daily Sales","AWANZ Sales by Item","AWANZ Sales by Associate",
           "AWANZ Hourly Sales Heatmap","AWANZ Client Purchases","AWANZ Serial Ledger","AWANZ Returns",
           "AWANZ Commission Statement","AWANZ Promotion Performance","AWANZ Campaign Performance"]
COMBOS = [
  ("today",            {"from_date":"2026-08-23","to_date":"2026-08-23"}),
  ("MTD all stores",   {"from_date":"2026-08-01","to_date":"2026-08-23"}),
  ("MTD HOU-MTR",      {"from_date":"2026-08-01","to_date":"2026-08-23","boutique":"HOU-MTR"}),
  ("90d OK-SAP",       {"from_date":"2026-05-22","to_date":"2026-08-23","boutique":"OK-SAP"}),
  ("empty window",     {"from_date":"2026-01-01","to_date":"2026-01-05"}),
  ("bad range",        {"from_date":"2026-08-23","to_date":"2026-08-01"}),
]
res=[]
for rep in REPORTS:
    for label, f in COMBOS:
        t0=time.time()
        r = dq.call("frappe.desk.query_report.run", {"report_name":rep,"filters":json.dumps(f),"ignore_prepared_report":1})
        ms=(time.time()-t0)*1000
        m = r.get("message")
        if m is None:
            exc = (r.get("exception") or str(r))[:180]
            ok = "bad range" in label and "From Date must be before" in exc
            res.append(dict(report=rep,combo=label,status="EXPECTED-THROW" if ok else "ERROR",detail=exc,ms=round(ms)))
            print(f"{'ok ' if ok else 'ERR'} {rep:32} {label:16} {round(ms):5} ms  {exc[:110]}")
        else:
            rows = m.get("result") or []
            cols = m.get("columns") or []
            nrow = len([x for x in rows if x])
            res.append(dict(report=rep,combo=label,status="OK",rows=nrow,cols=len(cols),ms=round(ms),
                            first=rows[0] if rows else None, chart=bool(m.get("chart")), summary=bool(m.get("report_summary"))))
            print(f"OK  {rep:32} {label:16} {round(ms):5} ms  rows={nrow:5} cols={len(cols):2} chart={'y' if m.get('chart') else 'n'}")
json.dump(res, open("/home/claude/awanz/e2e/qa/results-d6.json","w"), indent=1, default=str)
errs=[r for r in res if r["status"]=="ERROR"]
print(f"\n{len(res)} runs, {len(errs)} errors")
for e in errs: print("  !", e["report"], e["combo"], e["detail"][:200])
