import sys, json
sys.path.insert(0, "/home/claude/maison/e2e/qa")
from harness import Sess, sess, summ, PERSONAS, BASE
g = sess("guest"); adm = sess("admin"); mgr = sess("manager"); asc = sess("associate")

print("========== GUEST cannot reach authed maison_pos.api.* or generic reads ==========")
guest_probes = [
    ("GET","maison_pos.api.dashboard.live_summary",{}),
    ("GET","maison_pos.api.catalog.bootstrap",{"boutique":"OK-MINGO"}),
    ("GET","maison_pos.api.sales.list",{"boutique":"OK-MINGO"}),
    ("POST","maison_pos.api.sales.void",{"invoice":"x","reason":"y"}),
    ("GET","maison_pos.api.customers.search",{"q":"a"}),
    ("GET","maison_pos.api.inventory.alerts",{"boutique":"OK-MINGO"}),
    ("GET","maison_pos.api.shipping.wall",{}),
    ("GET","frappe.client.get_list",{"doctype":"Customer","fields":'["name","mobile_no"]',"limit_page_length":5}),
    ("GET","frappe.client.get_list",{"doctype":"Sales Invoice","fields":'["name","grand_total"]',"limit_page_length":5}),
    ("GET","frappe.client.get_list",{"doctype":"Maison Associate","fields":'["name","pin_hash"]',"limit_page_length":5}),
    ("GET","frappe.client.get_list",{"doctype":"User","fields":'["name","email"]',"limit_page_length":5}),
]
for meth, m, p in guest_probes:
    r = g.get(m, **p) if meth=="GET" else g.post(m, **p)
    body = ""
    try: body = json.dumps(r.json().get("message"))[:60]
    except: body = r.text[:60]
    print(f"  [{r.status_code}] {meth} {m} {p.get('doctype','')} -> {body}")

print("\n========== GUEST allow_guest endpoints (expected reachable) ==========")
for m,p in [("maison_pos.api.rewards.program",{}),("maison_pos.api.webshop.boutiques",{}),
            ("maison_pos.api.webshop.status",{}),("maison_pos.api.salon.state",{"token":"bogus"}),
            ("maison_pos.api.feedback.status",{"token":"bogus"}),("maison_pos.api.sales.receipt",{"token":"bogus"})]:
    r = g.get(m, **p)
    print(f"  [{r.status_code}] {m} -> {summ(r)[:80]}")

print("\n========== loyalty_lookup enumeration (guest) ==========")
# wrong email for a real client number should return None (no oracle)
r = g.get("maison_pos.api.webshop.loyalty_lookup", client_number="MC000001", email="nobody@x.com")
print("  bad pair:", summ(r)[:80])

print("\n========== CSRF enforcement on mutating POST (cookie session, NO token) ==========")
# manager POST without CSRF header
m_notoken = Sess(PERSONAS["manager"]); m_notoken.csrf = ""   # strip token
r = m_notoken.post("frappe.client.set_value", doctype="Maison Associate",
                   name="ok.mingo.a1@cloudchaserz.example", fieldname="failed_pin_attempts", value=0)
print("  manager set_value WITHOUT csrf token:", r.status_code, "->", ("CSRF ENFORCED" if r.status_code in (400,403) else "NOT ENFORCED (mutated!)"), r.text[:80])
# also a maison api mutation without token
r2 = m_notoken.post("maison_pos.api.crm.log_interaction", customer="x", type="Call")
print("  maison api POST WITHOUT csrf token:", r2.status_code, r2.text[:80])

print("\n========== expired / bogus sid behaviour ==========")
bad = Sess(); bad.s.cookies.set("sid","deadbeef"*7, domain="cloudchaserz.frappe.cloud")
r = bad.get("frappe.auth.get_logged_user")
print("  bogus sid get_logged_user:", r.status_code, r.text[:60])
r = bad.get("maison_pos.api.dashboard.live_summary")
print("  bogus sid live_summary:", r.status_code, "-> treated as", (bad.get("frappe.auth.get_logged_user").text[:40]))
