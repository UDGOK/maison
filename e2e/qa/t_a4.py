import sys, json
sys.path.insert(0, "/home/claude/maison/e2e/qa")
from harness import sess, summ, PERSONAS, BASE
adm=sess("admin"); g=sess("guest"); asc=sess("associate"); mgr=sess("manager")

print("=== /r/<token> guest receipt PII audit (real token) ===")
r = adm.get("frappe.client.get_list", doctype="Sales Invoice",
            filters=json.dumps([["maison_boutique","=","OK-MINGO"],["is_pos","=",1],["docstatus","=",1]]),
            fields=json.dumps(["name","maison_receipt_token","customer","customer_name"]),
            order_by="creation desc", limit_page_length=5)
rows=[x for x in r.json().get("message",[]) if x.get("maison_receipt_token")]
if rows:
    inv=rows[0]; tok=inv["maison_receipt_token"]
    print(f"  invoice {inv['name']} customer={inv.get('customer_name')} token={tok}")
    rr=g.get("maison_pos.api.sales.receipt", token=tok)
    j=rr.json().get("message",{})
    blob=json.dumps(j)
    cn=(inv.get('customer_name') or 'ZZZUNLIKELY')
    print("  [%s] receipt keys client=%s"%(rr.status_code, json.dumps(j.get('client'))))
    print("  associate_name on receipt:", j.get('associate_name'))
    print("  >>> customer NAME leaked in payload:", cn!='ZZZUNLIKELY' and cn in blob)
    print("  >>> full client_number leaked:", bool(j.get('client',{}).get('client_number')) )
    # also fetch the HTML page /r/<token>
    hp=g.s.get(f"{BASE}/r/{tok}", timeout=30)
    print("  /r/ html status:", hp.status_code, " customer name in html:", cn!='ZZZUNLIKELY' and cn in hp.text)
else:
    print("  no tokened invoice found")

print("\n=== A4: associate attempts sales.void (manager-only) ===")
if rows:
    rv=asc.post("maison_pos.api.sales.void", invoice=rows[0]["name"], reason="qa-test-should-fail")
    print("  associate void:", rv.status_code, "->", ("BLOCKED" if rv.status_code==403 else "ALLOWED!"), rv.text[:80])

print("\n=== A4: manager requests replenishment then self-approves ===")
req = mgr.post("maison_pos.api.inventory.replenish", boutique="OK-MINGO",
               lines=[{"item_code":"DSP-002","qty":1}], reason="qa self-approve test")
print("  manager replenish request:", summ(req)[:120])
reqname=None
try: reqname=req.json().get("message",{}).get("request") or req.json().get("message",{}).get("name")
except: pass
# find the request name if not returned
if not reqname:
    rl=mgr.get("maison_pos.api.inventory.replenishment_requests", boutique="OK-MINGO", status="all", limit=5)
    print("   requests list:", summ(rl)[:150])
if reqname:
    ap=mgr.post("maison_pos.api.shipping.approve", request=reqname)
    print(f"  manager self-approve {reqname}:", ap.status_code, "->", ("BLOCKED" if ap.status_code==403 else "ALLOWED!"), ap.text[:80])

print("\n=== A4: associate tampers a Maison Age Check (set result Verified) ===")
ac = adm.get("frappe.client.get_list", doctype="Maison Age Check",
             filters=json.dumps([["boutique","=","OK-MINGO"]]), fields=json.dumps(["name","result"]),
             order_by="creation desc", limit_page_length=1)
acr=ac.json().get("message",[])
if acr:
    acn=acr[0]["name"]; orig=acr[0]["result"]
    rt=asc.post("frappe.client.set_value", doctype="Maison Age Check", name=acn, fieldname="result", value="Verified")
    now=adm.get("frappe.client.get_value", doctype="Maison Age Check", filters=json.dumps({"name":acn}), fieldname="result").json().get("message",{}).get("result")
    print(f"  associate set_value age check {acn}: http={rt.status_code} result {orig}->{now}  TAMPERED={now=='Verified' and orig!='Verified'}")
    if now!=orig: adm.post("frappe.client.set_value", doctype="Maison Age Check", name=acn, fieldname="result", value=orig); print("  reverted")
else:
    print("  no age check rows in OK-MINGO")

print("\n=== D5 recheck: is Walk-in Customer still a rewards member? ===")
w=adm.get("frappe.client.get_value", doctype="Customer", filters=json.dumps({"customer_name":"Walk-in Customer"}),
          fieldname=json.dumps(["name","loyalty_program","maison_client_number"]))
print("  Walk-in Customer:", summ(w)[:160])
