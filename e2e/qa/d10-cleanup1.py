#!/usr/bin/env python3
"""D10 — clean up the assign-call and campaign test data."""
import json
from datetime import date, timedelta
import dq
CSRF=open("/tmp/cccsrf").read().strip()
def post(m,p): return dq.call(m,p,post=True,csrf=CSRF)

# --- 1. assign call ---
a=json.load(open("/home/claude/awanz/e2e/qa/created-assign.json"))
print("assign-call cleanup:", a)
r1=post("frappe.client.delete", {"doctype":"AWANZ Client Interaction","name":a["interaction"]})
print("  delete interaction:", json.dumps(r1, default=str)[:180])
for f in ("assigned_associate","assigned_at","call_task","crm_task"):
    post("frappe.client.set_value", {"doctype":"AWANZ Client Signal","name":a["signal"],"fieldname":f,"value":None})
sig=dq.get_list("AWANZ Client Signal", filters={"name":a["signal"]}, fields=["name","assigned_associate","call_task","crm_task","status"], limit=1)
print("  signal after reset:", sig)
print("  interaction still exists:", bool(dq.get_list("AWANZ Client Interaction", filters={"name":a["interaction"]}, fields=["name"], limit=1)))

# --- 2. campaign ---
c=json.load(open("/home/claude/awanz/e2e/qa/created-campaign.json"))
print("\ncampaign cleanup:", c)
for n in c["attributions"]:
    post("frappe.client.delete", {"doctype":"AWANZ Campaign Attribution","name":n})
for n in c["touches"]:
    post("frappe.client.delete", {"doctype":"AWANZ Campaign Touch","name":n})
print("  touches left:", dq.call("frappe.client.get_count",{"doctype":"AWANZ Campaign Touch"}).get("message"))
print("  attributions left:", dq.call("frappe.client.get_count",{"doctype":"AWANZ Campaign Attribution"}).get("message"))
job=post("maison_pos.api.campaigns.run_attribution", {"from_date": str(date(2026,7,9)), "to_date":"2026-08-23", "campaign":"EVENTS-LAUNCH"})
print("  re-run attribution:", json.dumps(job.get("message",job), default=str)[:300])
perf=dq.call("maison_pos.api.campaigns.performance")["message"]["campaigns"][0]
print(f"  campaign counters now: sends={perf['sends']} opens={perf['opens']} clicks={perf['clicks']} direct={perf['attributed_direct']} assisted={perf['attributed_assisted']} buyers={perf['buyers']} last_attributed_at={perf['last_attributed_at']}")
print("  attributions left:", dq.call("frappe.client.get_count",{"doctype":"AWANZ Campaign Attribution"}).get("message"))
