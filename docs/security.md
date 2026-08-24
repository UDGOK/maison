# Security & the permission model (v0.7)

This is the map of who may do what on a Maison POS chain, why the lines are drawn where they
are, and what is deliberately *not* locked down. It was written alongside the fixes for the six
holes in the QA audit (`e2e/qa/security-ux-report.md`, S1–S6); every one of them has a
regression test in `maison_pos/tests/test_v0_7_security.py` that reproduces the original exploit
and asserts it now fails.

Related: `maison_pos/scoping.py` (every rule below is one function in there), `docs/biometrics-policy.md`
(BIPA / face templates), `docs/white-label.md`.

---

## 1. The roles

| Role | Sees | May do |
|---|---|---|
| **Maison Associate** | their own boutique | sell, return (no void), create/serve clients, clock in |
| **Maison Manager** | their own boutique | the above + voids, return approval, price change requests, run their own shop floor (hire / edit / disable associates, reset their PINs) |
| **Maison Regional** | every boutique | read the chain, appoint managers, no accounting |
| **Maison Head Office** | every boutique | everything on the retail side, including appointing regionals / head office |
| **Maison Warehouse Admin** | every boutique's supply documents | approve replenishment, pick/ship/receive — **never sells** |
| **System Manager** | everything | the platform administrator |

Two predicates decide almost everything (`maison_pos/scoping.py`):

* `is_unrestricted(user)` — Administrator, System Manager, Head Office, Regional. May act on any
  boutique, and is the only kind of user that may hand out privileges.
* `is_store_scoped(user)` — Manager or Associate. Pinned to the single boutique on their
  `Maison Associate` row. Everyone else (a portal shopper, an accountant, a plain Stock User)
  is governed by core Frappe permissions and is neither.

Store scoping is enforced in three independent places, because any one of them can be bypassed
by a path the others do not see:

1. **API level** — `assert_boutique_access(boutique)` on every endpoint that takes a boutique.
2. **List level** — `permission_query_conditions` (hooks.py) narrow `frappe.client.get_list` /
   `/api/resource/<dt>` for `Sales Invoice`, `Sales Order`, `Delivery Note`, `Customer`,
   `Maison Associate` and every boutique-stamped Maison doctype.
3. **Document level** — `has_permission` hooks for the same doctypes, which is what
   `frappe.client.get` and `Document.check_permission` consult.

---

## 2. `Maison Associate` is the credential store — treat it as one

This doctype links a Frappe `User` to a boutique, carries the role that the `Maison *` Frappe
role is synced from, and holds the POS unlock PIN. Three field groups, three permlevels:

| Fields | Permlevel | Read | Write |
|---|---|---|---|
| `full_name`, `enabled`, `employee` | 0 | every Maison role | Manager (own store, Associate level), Regional, Head Office, System Manager |
| `user`, `boutique`, `role` | **1** | every Maison role | Regional, Head Office, System Manager |
| `pin`, `pin_hash`, `pin_set_on`, `failed_pin_attempts` | **2** | **System Manager only** | System Manager only |

### Why `user` / `boutique` / `role` are permlevel 1 (S1, S5)

Those three fields *are* the authorisation decision. `role` drives `_sync_user_role`, which grants
the matching Frappe role; `boutique` is the value every scoped query keys on; `user` says whose
record it is. Before v0.7 a store manager had plain `write` at permlevel 0 and could
`frappe.client.set_value` their own `role` to `HeadOffice` — the sync hook then granted
`Maison Head Office` with `ignore_permissions=True` and the manager could read all eleven stores.

The fix is deliberately layered, because each layer catches a different bypass:

* **permlevel 1** — the framework resets the field to its stored value on save
  (`validate_higher_perm_levels`), so nothing changes even if a check is missed;
* **`scoping.associate_has_permission`** — runs from `Document.check_permission` *before* that
  reset, so the caller gets an honest **403** instead of a silent no-op, and it also scopes reads;
* **`MaisonAssociate._guard_privileged_fields`** in `validate` — the last line, and the only one
  that still applies when a site's Custom DocPerms have been hand-edited;
* **`_sync_user_role`** refuses to grant a rank above the *granting* user's own
  (`Associate < Manager < Regional < HeadOffice`), so even server code running with
  `ignore_permissions` cannot mint a Head Office; and a **demotion now takes the old Frappe role
  back off the User**, which the old add-only sync never did.

A manager keeps their real job through
`maison_pos.maison_pos.doctype.maison_associate.maison_associate.upsert` — create or edit an
associate **in their own boutique at Associate level**, with `reset_pin` alongside it. Anything
above that (appointing a manager, moving somebody between stores) is Head Office work.

### Why the PIN material is permlevel 2 *and* out of the table (S2)

A PIN is 4–6 digits: at most a million candidates. Whoever holds the hash walks straight past the
five-attempt online lockout and cracks it offline, so the hash is a credential, not a checksum.
The audit found `frappe.client.get_list("Maison Associate", fields=[…,"pin_hash"])` returning
every associate of every store, managers included.

* `pin_hash` is a **`Password` field**: the value is encrypted into Frappe's `__Auth` table and
  the doctype column holds nothing but `*****`. That matters beyond tidiness — Frappe gates
  *fields* by permlevel but not *filters*, so a readable column is still an oracle
  (`filters=[["pin_hash","like","pbkdf2_sha256$600000$ab%"]]`, ~1 000 requests to extract a hash).
  There is no column left to interrogate.
* permlevel 2 keeps the field out of every list, form load and `/api/resource` response.
* `permission_query_conditions` + `has_permission` keep a store user to their own store's rows.
* PBKDF2-SHA256 iterations went **120 000 → 600 000** (OWASP's current figure), and a successful
  unlock transparently re-hashes an older or weaker record. ~0.4 s per verify at the till.

`session.associates()` and `catalog.bootstrap()` — what the unlock screen reads — select safe
fields explicitly through `frappe.get_all`, so they are unaffected; the PWA's offline unlock
compares a digest it computed on the device after an online verify, and never receives a
server-side hash.

### Demo credentials

**The seeded PINs and passwords are shared constants** — `maison123` for every demo user,
`1234` for every manager, `2580` / `1357` for the associates, and they are identical on every
seeded site. They exist so a demo can be picked up by anyone; knowing the role is knowing the
credential. A seeded site must therefore never hold real client data, and any site that is
reachable from the internet must be re-credentialed first: a new PIN per associate through
`maison_associate.reset_pin`, new passwords, and `bench --site … set-admin-password`.

---

## 3. The public surface

Everything reachable without a session is `allow_guest`, which means the rules have to be in the
endpoint, not in the caller.

### Sign-up may never touch somebody else's record (S3)

`rewards.signup` used to elevate to `Administrator` and call `customers.upsert`, which *matches*
an existing Customer by e-mail or phone and overwrites it. Anyone who knew a client's e-mail
could rewrite their name, phone, marketing consent and preferred store — and the response handed
back the victim's client number.

An anonymous sign-up now:

* **never writes to an existing Customer.** If the phone or e-mail is already on file, nothing is
  modified at all;
* **never reveals whether it was on file.** The acknowledgement ("check your e-mail, or ask for
  your card next time you are in store") is byte-identical either way, carries no client number,
  and the input is validated *before* the lookup so a malformed address fails the same way in
  both cases;
* still creates and enrols a genuinely new member, with no elevation — the insert runs with
  `ignore_permissions` on a brand-new document only.

Linking a walk-in to an existing client is a counter decision, so **a signed-in member of staff**
(a Maison role or System Manager) still gets the linking behaviour and the client number, and the
call is written to the security log.

*Deliberately left as is:* `salon.signup`. The Salon is a paired in-store tablet — the session
token is minted by an authenticated associate at the till, expires in 12 hours, and the client is
standing there. It completes an existing record's blank fields and answers with a **masked**
summary (`MC •• 284`, `•••• 0105`), so it neither leaks a client number nor rewrites a name.

### Rate limiting (S4)

`maison_pos/ratelimit.py`. Two things were wrong before: `rewards.signup` set
`frappe.rate_limit = None` (an attribute nothing reads — the limit did not exist), and the Salon
counted against `frappe.local.request_ip`, which the framework takes from the **first**
`X-Forwarded-For` hop. Behind a proxy that hop is written by the client, so varying it bought a
fresh bucket every time; the audit sent 16 `salon.pair` calls against a limit of 12 and none were
blocked.

`client_ip()` resolves the caller from the *trusted* end of the chain:

1. `maison_client_ip_header` in site config — when the edge sets a single-value header it
   controls (`CF-Connecting-IP`, `X-Real-IP`), that wins outright;
2. `maison_trusted_proxy_hops` — *N* proxies append to `X-Forwarded-For`, so the client is the
   *N*-th entry from the right. **Set this on any deployment with a CDN in front**;
3. otherwise the right-most *public* hop (our own load balancers are private), falling back to
   the right-most parseable hop on a single-host deployment;
4. then the framework's own value, and finally one shared bucket.

IPv6 is bucketed by `/64` so one allocation cannot cycle addresses. Every endpoint also has a
**global ceiling** with no identity in the key at all, which is what a distributed flood runs
into. Rejections are `429` with a human sentence and no traceback.

| Endpoint | Per client | Ceiling |
|---|---|---|
| `rewards.signup` | 5 / 10 min | 120 / 10 min |
| `rewards.program` | 60 / min | 1 200 / min |
| `salon.pair` | 12 / min | 300 / min |
| `salon.identify` | 30 / min | 750 / min |
| `salon.signup` / `feedback` / `consent` / `email_receipt` | 10 / min | 250 / min |
| `salon.ask` / `preferences` | 20 / min | 500 / min |
| `feedback.submit` | 20 / h | 600 / h |
| `sales.receipt`, `feedback.status` | 60 / min | 1 200 / min |
| `webshop.catalogue` / `availability` / `boutiques` | 120 / min | 3 600 / min |
| `webshop.enquire` | 5 / 10 min | 150 / 10 min |
| `webshop.loyalty_lookup` (by client number + e-mail) | 15 / 10 min | 450 / 10 min |
| `maison_associate.verify_pin` (authenticated) | 20 / 5 min per associate | 600 / 5 min |

Off switch for load tests: `bench set-config -g maison_rate_limits 0`.

*Deliberately left as is:* the campaign webhooks (`campaigns.webhook_klaviyo` / `_brevo`). They
are HMAC-gated on the first line, are delivered in legitimate bursts from many provider IPs, and
throttling them loses real events.

---

## 4. Client data: chain-wide service, per-store lists (S6)

A client of this chain shops wherever they like, so staff must be able to find them from any
till — but "any associate can download the whole client book" is not the same requirement.
The line drawn in v0.7:

* **`Customer` list queries are scoped.** For a Manager or Associate, `frappe.client.get_list`
  and `/api/resource/Customer` return only clients **linked to their store**: someone who has
  bought there, whose record was created by one of that store's users, or whose client profile
  names it as their preferred boutique (`scoping.customer_query`). Bulk enumeration of the chain
  is closed.
* **Service lookups still cross the chain.** `customers.search` / `customers.lookup` /
  `customers.get` use the query builder, not the list API, so a Chicago associate can still find
  a New York client at the counter. What changed for store users: a query must be at least 3
  characters, text matches are anchored to the start of a name or word instead of `%q%`
  anywhere, results are capped at 25, an **empty** query lists their own store's clients rather
  than the chain's most recent, and every lookup that returns a client from another store is
  written to `logs/maison_security.log` (`maison_pos/audit.py`) with the user, the store, the
  query and the customer ids.
* `customers.history` was already scoped to the caller's own boutique.

*Deliberately left as is, with reasons:*

* **Single-document reads of a `Customer`.** `/api/resource/Customer/<name>` is not blocked for a
  store user: the POS, ERPNext's own selling code and the desk all read customers by name, and
  the caller must already know the record's name to ask. The enumeration route — the list — is
  what is closed.
* **`User` enumeration.** Any authenticated user can list `User` rows (names and e-mail
  addresses of colleagues). That is Frappe's default, the desk's link fields depend on it, and
  the data is a staff directory rather than client PII. Revisit if a tenant ever hosts unrelated
  chains on one site.
* **Void has no amount threshold or dual control.** A manager can void any amount. This is a
  business control, not a technical hole; it needs a policy decision (threshold, second
  approver) before it is worth building.

---

## 5. Upgrading an existing site

`maison_pos/patches/v0_7/associate_hardening.py` (runs from `bench migrate`, idempotent):

1. moves every `pbkdf2_sha256$…` value out of the `Maison Associate.pin_hash` column into
   `__Auth`, leaving asterisks behind;
2. mirrors the permlevel-1 / permlevel-2 rows into **Custom DocPerm** when the site has any (as
   soon as one Custom DocPerm row exists for a doctype, Frappe ignores the JSON's standard
   permissions) — also re-asserted on every migrate from `setup.install.after_migrate`;
3. re-syncs every user who has a `Maison Associate` row to exactly the Frappe role that row
   says, **removing anything extra** — which is what takes back a role somebody granted
   themselves before the fix — and logs each correction to the security log.

After migrating, check `logs/maison_security.log` for two events:

* `patch.v0_7.role_grants_repaired` — a user who was holding a role their associate record did
  not justify; the patch took it back;
* `patch.v0_7.role_without_associate_record` — a user with a `Maison *` role and **no**
  `Maison Associate` row at all. The patch deliberately does not touch these (an admin may have
  granted Head Office to somebody who does not stand on a shop floor), but each one is
  unrestricted and unattached, so review the list by hand.
