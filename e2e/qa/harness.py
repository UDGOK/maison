"""QA security harness for the live CloudChaserz site.
Read-only by default. Any write is prefixed and reverted by the caller.
"""
import os, re, json, sys, time
import requests

os.environ.setdefault("REQUESTS_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
BASE = "https://cloudchaserz.frappe.cloud"
PWD = "cloud123"

PERSONAS = {
    "associate":   "ok.mingo.a1@cloudchaserz.example",   # AWANZ Associate @ OK-MINGO
    "assoc_etul":  "ok.etul.a1@cloudchaserz.example",     # AWANZ Associate @ OK-ETUL
    "manager":     "ok.mingo.manager@cloudchaserz.example",  # AWANZ Manager @ OK-MINGO (store A)
    "manager_b":   "ok.etul.manager@cloudchaserz.example",   # AWANZ Manager @ OK-ETUL (store B)
    "warehouse":   "warehouse@cloudchaserz.example",      # Warehouse Admin @ HOU-WH
    "hq":          "hq@cloudchaserz.example",             # Head Office
}

class Sess:
    def __init__(self, user=None, pwd=PWD, admin_sid=None):
        self.s = requests.Session()
        self.user = user or "Guest"
        self.csrf = ""
        if admin_sid:
            self.s.cookies.set("sid", admin_sid, domain="cloudchaserz.frappe.cloud")
            self.user = "Administrator"
        elif user:
            r = self.s.post(f"{BASE}/api/method/login", json={"usr": user, "pwd": pwd}, timeout=20)
            assert r.ok, f"login {user}: {r.status_code} {r.text[:200]}"
        # scrape CSRF token from /pos page (works for logged-in users)
        try:
            page = self.s.get(f"{BASE}/pos", timeout=20).text
            m = re.search(r'csrf_token"?\s*[:=]\s*"([^"]+)"', page)
            self.csrf = m.group(1) if m else ""
        except Exception:
            pass

    def get(self, method, **params):
        return self.s.get(f"{BASE}/api/method/{method}", params=params, timeout=40)

    def post(self, method, **data):
        return self.s.post(f"{BASE}/api/method/{method}", json=data,
                           headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=40)

    def post_raw(self, method, data, headers=None):
        h = {"X-Frappe-CSRF-Token": self.csrf}
        if headers: h.update(headers)
        return self.s.post(f"{BASE}/api/method/{method}", data=data, headers=h, timeout=40)

    def resource(self, path, method="GET", **kw):
        return self.s.request(method, f"{BASE}/api/resource/{path}", timeout=40,
                              headers={"X-Frappe-CSRF-Token": self.csrf} if method!="GET" else {}, **kw)

def summ(r):
    """Compact result summary."""
    try:
        j = r.json()
        msg = j.get("message", j)
        s = json.dumps(msg)[:400]
    except Exception:
        s = (r.text or "")[:400]
    return f"[{r.status_code}] {s}"

_cache = {}
def sess(name):
    if name == "guest":
        if "guest" not in _cache: _cache["guest"] = Sess()
        return _cache["guest"]
    if name == "admin":
        if "admin" not in _cache:
            _cache["admin"] = Sess(admin_sid=open("/tmp/ccsid").read().strip())
        return _cache["admin"]
    if name not in _cache:
        _cache[name] = Sess(PERSONAS[name])
    return _cache[name]

if __name__ == "__main__":
    for n in ("guest","associate","manager","manager_b","warehouse","hq","admin"):
        try:
            who = sess(n).get("frappe.auth.get_logged_user")
            print(f"{n:12} -> {who.json().get('message')}  csrf={'y' if sess(n).csrf else 'n'}")
        except Exception as e:
            print(f"{n:12} -> ERR {e}")
