import sys, json
sys.path.insert(0, "/home/claude/awanz/e2e/qa")
from harness import sess, summ

mgr = sess("manager")      # AWANZ Manager @ OK-MINGO
asc = sess("associate")    # AWANZ Associate @ OK-MINGO
adm = sess("admin")

def getv(s, dt, name, field):
    r = s.get("frappe.client.get_value", doctype=dt, filters=json.dumps({"name":name}), fieldname=field)
    return r.json().get("message",{}).get(field) if r.ok else f"ERR{r.status_code}"

print("=== E1: Manager writes to ANOTHER store's AWANZ Associate (cross-store write) ===")
tgt = "ok.etul.a1@cloudchaserz.example"   # OK-ETUL associate
orig = getv(adm, "AWANZ Associate", tgt, "full_name")
print("  target OK-ETUL associate full_name (orig):", orig)
r = mgr.post("frappe.client.set_value", doctype="AWANZ Associate", name=tgt, fieldname="full_name", value="QA-SECUX-MARK")
print("  manager set_value cross-store:", summ(r)[:160])
now = getv(adm, "AWANZ Associate", tgt, "full_name")
print("  full_name after manager write:", now, " -> CROSS_STORE_WRITE_OK =", now=="QA-SECUX-MARK")
if now == "QA-SECUX-MARK":
    rv = adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=tgt, fieldname="full_name", value=orig)
    print("  reverted:", getv(adm,"AWANZ Associate",tgt,"full_name"))

print("=== E2: Manager repoints their OWN boutique to another store (self-escalation) ===")
me = "ok.mingo.manager@cloudchaserz.example"
orig_b = getv(adm, "AWANZ Associate", me, "boutique")
print("  own boutique (orig):", orig_b)
r = mgr.post("frappe.client.set_value", doctype="AWANZ Associate", name=me, fieldname="boutique", value="OK-ETUL")
print("  manager repoint self:", summ(r)[:160])
now_b = getv(adm, "AWANZ Associate", me, "boutique")
print("  own boutique after:", now_b, " -> SELF_REPOINT_OK =", now_b=="OK-ETUL")
if now_b != orig_b:
    adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=me, fieldname="boutique", value=orig_b)
    print("  reverted own boutique ->", getv(adm,"AWANZ Associate",me,"boutique"))

print("=== E3: Manager promotes an associate role Associate->Manager (own store) ===")
a1 = "ok.mingo.a1@cloudchaserz.example"
orig_r = getv(adm, "AWANZ Associate", a1, "role")
r = mgr.post("frappe.client.set_value", doctype="AWANZ Associate", name=a1, fieldname="role", value="Manager")
now_r = getv(adm, "AWANZ Associate", a1, "role")
print(f"  role {orig_r}->{now_r}  ROLE_WRITE_OK={now_r=='Manager'}  ", summ(r)[:100])
if now_r != orig_r:
    adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=a1, fieldname="role", value=orig_r)
    print("  reverted role ->", getv(adm,"AWANZ Associate",a1,"role"))

print("=== E4: Associate escalates own Frappe role (add AWANZ Manager to own User) ===")
r = asc.post("frappe.client.set_value", doctype="User", name="ok.mingo.a1@cloudchaserz.example", fieldname="role_profile_name", value="x")
print("  associate write User:", summ(r)[:120])
# also try inserting Has Role via resource
r2 = asc.resource("User/ok.mingo.a1@cloudchaserz.example", method="PUT",
                  json={"roles":[{"role":"AWANZ Manager"}]})
print("  associate add role via /api/resource PUT:", r2.status_code, r2.text[:120])

print("=== E5: Associate writes to own AWANZ Associate row (self boutique/role) ===")
r = asc.post("frappe.client.set_value", doctype="AWANZ Associate", name=a1, fieldname="boutique", value="OK-ETUL")
print("  associate self set_value boutique:", summ(r)[:120], " (should be 403)")
