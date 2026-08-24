import sys, time, json
sys.path.insert(0, "/home/claude/maison/e2e/qa")
from harness import sess, summ, BASE

g = sess("guest")
adm = sess("admin")
ts = int(time.time())
email = f"qa-secux-{ts}@qa.invalid"
created = []

print("### 1) Guest creates a NEW customer via public rewards.signup (as Administrator, no rate limit)")
r1 = g.post("maison_pos.api.rewards.signup", name="QA-SECUX ORIG", email=email, consent=1)
print("   signup#1:", summ(r1))
cn1 = r1.json().get("message", {}).get("client_number")
created.append(email)

print("### 2) Guest signup AGAIN with the SAME email but different name+phone -> account-takeover / update path")
r2 = g.post("maison_pos.api.rewards.signup", name="QA-SECUX HIJACKED", phone="15550009999", email=email, consent=1)
print("   signup#2:", summ(r2))
cn2 = r2.json().get("message", {}).get("client_number")

print(f"   client_number#1={cn1}  client_number#2={cn2}  SAME_RECORD={cn1==cn2 and cn1 is not None}")

print("### 3) Admin verifies the record was overwritten by the anonymous caller")
cust = adm.get("frappe.client.get_value", doctype="Customer",
               filters=json.dumps({"maison_client_number": cn1}),
               fieldname=json.dumps(["name","customer_name","mobile_no","email_id","maison_client_number","loyalty_program"]))
print("   customer now:", summ(cust))

print("### 4) Rate-limit probe: 12 rapid guest signups with distinct emails")
codes = []
for i in range(12):
    rr = g.post("maison_pos.api.rewards.signup", name=f"QA-SECUX RL{i}", email=f"qa-secux-rl-{ts}-{i}@qa.invalid", consent=1)
    codes.append(rr.status_code)
    if rr.ok:
        created.append(f"qa-secux-rl-{ts}-{i}@qa.invalid")
print("   status codes:", codes, " -> any 429 (throttled)?", 429 in codes)

# save created emails for cleanup
open("/tmp/qa_signup_created.json","w").write(json.dumps(created))
print("### created (for cleanup):", created)
