import sys, json
sys.path.insert(0, "/home/claude/awanz/e2e/qa")
from harness import sess, summ
mgr = sess("manager")   # AWANZ Manager @ OK-MINGO
B = "OK-ETUL"

# (method, params, is_post) — all target store B; a scoped manager must get 403
probes = [
    ("age.settings", {"boutique":B}, 0),
    ("age.recent", {"boutique":B}, 0),
    ("catalog.bootstrap", {"boutique":B}, 0),
    ("catalog.delta", {"boutique":B,"since":"2020-01-01"}, 0),
    ("crm.tasks", {"boutique":B}, 0),
    ("crm.wishlist_matches", {"boutique":B}, 0),
    ("crm.upcoming_dates", {"boutique":B}, 0),
    ("dashboard.boutique_feed", {"boutique":B}, 0),
    ("dashboard.boutique_detail", {"boutique":B}, 0),
    ("dashboard.recent_sales", {"boutique":B}, 0),
    ("dashboard.product_trends", {"scope":"boutique","boutique":B}, 0),
    ("dashboard.clients_overview", {"boutique":B}, 0),
    ("feedback.list", {"boutique":B}, 0),
    ("hr.on_shift", {"boutique":B}, 0),
    ("hr.shifts", {"boutique":B}, 0),
    ("hr.employee_performance", {"boutique":B}, 0),
    ("insights.client_signals", {"boutique":B}, 0),
    ("insights.product_performance", {"boutique":B}, 0),
    ("inventory.alerts", {"boutique":B}, 0),
    ("inventory.inbound", {"boutique":B}, 0),
    ("inventory.cycle_count_expected", {"boutique":B}, 0),
    ("inventory.replenishment_requests", {"boutique":B}, 0),
    ("promotions.active", {"boutique":B}, 0),
    ("promotions.performance", {"boutique":B}, 0),
    ("recognition.templates", {"boutique":B}, 0),
    ("reports.period_comparison", {"boutique":B}, 0),
    ("rewards.tiers", {"boutique":B}, 0),
    ("rewards.giveaways", {"boutique":B}, 0),
    ("sales.list", {"boutique":B}, 0),
    ("salon.pairing_code", {"boutique":B,"pos_device_id":"QA"}, 0),
    ("shipping.requests_list", {"boutique":B}, 0),
    ("shipping.shipments", {"boutique":B}, 0),
    ("campaigns.performance", {"boutique":B}, 0),
    ("session.associates", {"boutique":B}, 0),
]
leaks=[]; oks=0; errs=[]
for m, p, post in probes:
    full = f"maison_pos.api.{m}"
    r = mgr.post(full, **p) if post else mgr.get(full, **p)
    sc = r.status_code
    if sc == 403:
        oks += 1
    elif sc == 200:
        # 200 could be a leak of store B data, OR a harmless empty/own-scoped response
        body = summ(r)[:120]
        leaks.append((m, sc, body))
    else:
        errs.append((m, sc, r.text[:80]))
print(f"403 (correctly denied): {oks}/{len(probes)}")
print(f"\n200 responses to review for store-B leakage ({len(leaks)}):")
for m,sc,b in leaks: print(f"  [{sc}] {m}: {b}")
print(f"\nOther statuses ({len(errs)}):")
for m,sc,b in errs: print(f"  [{sc}] {m}: {b}")
