#!/usr/bin/env python3
"""Query helper for the live CloudChaserz site (admin sid)."""
import json, os, subprocess, sys, urllib.parse

BASE = "https://cloudchaserz.frappe.cloud"
SID = open("/tmp/ccsid").read().strip()

def call(method, params=None, post=False, csrf=None):
    url = f"{BASE}/api/method/{method}"
    args = ["curl", "-s", "-S"]
    if post:
        args += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(params or {})]
        if csrf:
            args += ["-H", f"X-Frappe-CSRF-Token: {csrf}"]
    else:
        if params:
            url += "?" + urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v,(dict,list)) else v) for k,v in params.items()})
    args += ["-H", f"Cookie: sid={SID}", url]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out[:4000]}

def sql(query):
    """Run read-only SQL through frappe.client.get_list is not possible; use a report-style call."""
    raise NotImplementedError

def get_list(doctype, filters=None, fields=None, limit=1000, order_by=None, group_by=None, parent=None):
    p = {"doctype": doctype, "limit_page_length": limit}
    if filters: p["filters"] = filters
    if fields: p["fields"] = fields
    if order_by: p["order_by"] = order_by
    if group_by: p["group_by"] = group_by
    if parent: p["parent"] = parent
    r = call("frappe.client.get_list", p)
    return r.get("message", r)

if __name__ == "__main__":
    m = sys.argv[1]
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
    print(json.dumps(call(m, params), indent=1)[:20000])
