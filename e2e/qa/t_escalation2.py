import sys, json
sys.path.insert(0, "/home/claude/awanz/e2e/qa")
from harness import Sess, sess, summ, PERSONAS
adm = sess("admin")

def roles_of(u):
    r = adm.get("frappe.client.get", doctype="User", name=u)
    return sorted([x["role"] for x in r.json().get("message",{}).get("roles",[])])

def boutique_of(u):
    return adm.get("frappe.client.get_value", doctype="AWANZ Associate",
                   filters=json.dumps({"name":u}), fieldname="boutique").json().get("message",{}).get("boutique")

AU = "ok.mingo.a1@cloudchaserz.example"
MU = "ok.mingo.manager@cloudchaserz.example"

print("### baseline associate roles:", roles_of(AU))
# FRESH associate session (clean, post-revert)
a = Sess(PERSONAS["associate"])

print("\n=== X1: fresh Associate adds AWANZ Manager to OWN User via /api/resource PUT ===")
before = roles_of(AU)
r = a.resource(f"User/{AU}", method="PUT", json={"roles":[{"role":x} for x in before] + [{"role":"AWANZ Manager"}]})
after = roles_of(AU)
print(f"  http={r.status_code}  before={before}\n  after ={after}\n  GAINED_MANAGER={'AWANZ Manager' in after and 'AWANZ Manager' not in before}")
gained_mgr = "AWANZ Manager" in after and "AWANZ Manager" not in before
if gained_mgr:
    adm.resource(f"User/{AU}", method="PUT", json={"roles":[{"role":x} for x in before]})
    print("  reverted ->", roles_of(AU))

print("\n=== X2: fresh Associate tries to add SYSTEM MANAGER (site-takeover ceiling) ===")
a2 = Sess(PERSONAS["associate"])   # fresh, clean again
before = roles_of(AU)
r = a2.resource(f"User/{AU}", method="PUT", json={"roles":[{"role":x} for x in before] + [{"role":"System Manager"}]})
after = roles_of(AU)
print(f"  http={r.status_code}  GAINED_SYSTEM_MANAGER={'System Manager' in after}")
if "System Manager" in after and "System Manager" not in before:
    adm.resource(f"User/{AU}", method="PUT", json={"roles":[{"role":x} for x in before]})
    print("  reverted ->", roles_of(AU))

print("\n=== X3: fresh Associate tries frappe.client.insert of Has Role on self ===")
a3 = Sess(PERSONAS["associate"])
before = roles_of(AU)
r = a3.post("frappe.client.insert", doc=json.dumps({"doctype":"Has Role","parent":AU,"parenttype":"User","parentfield":"roles","role":"AWANZ Head Office"}))
after = roles_of(AU)
print(f"  http={r.status_code} {summ(r)[:90]}  GAINED_HEAD_OFFICE={'AWANZ Head Office' in after and 'AWANZ Head Office' not in before}")
if "AWANZ Head Office" in after and "AWANZ Head Office" not in before:
    adm.resource(f"User/{AU}", method="PUT", json={"roles":[{"role":x} for x in before]})
    print("  reverted")

print("\n=== X4: fresh Associate self set_value AWANZ Associate.boutique (write=None expected) ===")
a4 = Sess(PERSONAS["associate"])
ob = boutique_of(AU)
r = a4.post("frappe.client.set_value", doctype="AWANZ Associate", name=AU, fieldname="boutique", value="OK-ETUL")
nb = boutique_of(AU)
print(f"  http={r.status_code}  boutique {ob}->{nb}  ASSOC_SELF_REPOINT={nb=='OK-ETUL'}")
if nb != ob:
    adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=AU, fieldname="boutique", value=ob); print("  reverted")

print("\n=== X5: fresh Manager self-repoints OWN boutique (isolated) ===")
m = Sess(PERSONAS["manager"])
ob = boutique_of(MU)
r = m.post("frappe.client.set_value", doctype="AWANZ Associate", name=MU, fieldname="boutique", value="OK-ETUL")
nb = boutique_of(MU)
print(f"  http={r.status_code}  boutique {ob}->{nb}  MGR_SELF_REPOINT={nb=='OK-ETUL'}")
if nb != ob:
    adm.post("frappe.client.set_value", doctype="AWANZ Associate", name=MU, fieldname="boutique", value=ob); print("  reverted ->", boutique_of(MU))

print("\n### final associate roles (must equal baseline):", roles_of(AU))
print("### final manager boutique:", boutique_of(MU), " associate boutique:", boutique_of(AU))
