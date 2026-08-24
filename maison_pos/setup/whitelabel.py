"""v0.7 — white-label: nothing in the product surface says "Frappe" or "ERPNext".

The client buys a product, not a Frappe install. Everything here reads
:mod:`maison_pos.brand` (``AWANZ POS Settings``) **at apply time**, so the jewellery tenant
and every future tenant come out right without a line of code changing.

Three layers, all idempotent and all reversible:

1. **Settings** — Website Settings (``app_name``, ``title_prefix``, ``brand_html``, ``app_logo``,
   ``favicon``, ``splash_image``, ``footer_logo``, ``copyright``, ``footer_powered``,
   ``hide_footer_signup``), Navbar Settings (desk logo, the Help menu's frappe.io / erpnext.com
   links) and System Settings (``app_name``, the standard "Sent via ERPNext" mail footer).
   :func:`apply_whitelabel` snapshots the previous values first so :func:`revert_whitelabel`
   can put them back.
2. **Templates** — ``maison_pos/templates/includes/footer/{footer_powered,footer_extension}.html``
   and ``maison_pos/www/404.html``. Frappe's Jinja loader searches installed apps in reverse
   install order, so ours shadow ERPNext's without patching anything upstream.
3. **Request / response hooks** — :func:`website_context` (drops the "Login with Frappe Cloud"
   button and keeps the brand tokens on every web page), :func:`scrub_response` (the two
   framework strings that live outside any Jinja block, plus the framework response headers) and
   :func:`scrub_email_headers` (``X-Frappe-Site`` on outgoing mail).

**What deliberately stays.** Licences and copyright notices are *not* UI chrome: the LICENSE
files, the per-file copyright headers, the package metadata and
:func:`attribution` (``/api/method/maison_pos.setup.whitelabel.attribution``) keep naming the
upstream projects, exactly as the MIT (Frappe) and GPLv3 (ERPNext) licences require. See
``docs/white-label.md``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

import frappe
from frappe.utils import cint, now_datetime

# Marker + snapshot of the values we overwrote, so a revert restores the site exactly.
BACKUP_KEY = "awanz_whitelabel_backup"
VERSION = "0.7"

# `scrub_response` runs on every response; the product name it brands headers with is cached in
# redis rather than re-read from the database each time. Invalidated by apply / revert.
PRODUCT_NAME_CACHE_KEY = "awanz_product_name"
BRAND_MARK_CACHE_KEY = "awanz_brand_mark_url"
FALLBACK_PRODUCT_NAME = "AWANZ POS"
FALLBACK_MARK = "/assets/maison_pos/favicon.svg"

# Frappe / ERPNext strings that live outside any Jinja block in ``frappe/templates/base.html``
# and can therefore only be replaced on the rendered response.
_GENERATOR_META = b'<meta name="generator" content="frappe">'
_BUILT_ON_COMMENT = b"<!-- Built on Frappe. https://frappeframework.com/ -->"

# Navbar "Help" entries that point at frappe.io / erpnext.com. Hidden, never deleted —
# Navbar Settings refuses to lose a standard row.
FRAMEWORK_HELP_ITEMS = (
	"Documentation",
	"User Forum",
	"Frappe School",
	"Report an Issue",
	"Frappe Support",
)

SUPPORT_ITEM_LABEL_SUFFIX = "Support"

# Desk sidebar entries that carry the framework's name in their *title* — "Frappe CRM",
# "ERPNext Settings", "ERPNext Integrations". Only the title is rewritten: `Workspace.label` is
# the document name and the desk route (/app/frappe-crm), an internal identifier like a doctype
# name, and renaming it would break `parent_page` links and be undone by the next migrate.
FRAMEWORK_WORD = re.compile(r"\b(frappe|erpnext)\b", re.I)

WEBSITE_KEYS = (
	"app_name",
	"title_prefix",
	"brand_html",
	"app_logo",
	"favicon",
	"splash_image",
	"footer_logo",
	"copyright",
	"footer_powered",
	"hide_footer_signup",
	"banner_html",
)
SYSTEM_KEYS = (
	"app_name",
	"disable_standard_email_footer",
	"email_footer_address",
	"otp_issuer_name",
	"enable_onboarding",
)


# ---------------------------------------------------------------------------
# brand -> the values every surface should carry
# ---------------------------------------------------------------------------
def _brand() -> dict[str, Any]:
	"""Brand settings, re-read from the database. For apply / revert / status, where freshness
	matters more than the cost of one query."""
	from maison_pos.brand import clear_brand_cache, get_brand

	clear_brand_cache()
	return get_brand()


def _live_brand() -> dict[str, Any]:
	"""Brand settings off the per-request cache. For the hooks, which run on every request."""
	from maison_pos.brand import get_brand

	return get_brand()


def brand_mark_url(brand: Optional[dict[str, Any]] = None) -> str:
	"""URL of the tenant's square mark: their uploaded logo, else a generated wordmark initial.

	The generated file is a real public File (``/files/…`` , served by nginx in production) so
	favicon / app logo / splash are ordinary static URLs, not an API call. Always **site-relative**
	— ``get_brand()`` absolutises the logo for the POS bootstrap, but a settings row must not
	freeze one hostname into every page of a site reachable under several.
	"""
	b = brand or _brand()
	stored = _stored_brand_logo() or b.get("brand_logo")
	if stored:
		return _relative(str(stored))
	return _ensure_generated_mark(b)


def _stored_brand_logo() -> Optional[str]:
	try:
		return frappe.db.get_single_value("AWANZ POS Settings", "brand_logo")
	except Exception:
		return None


def _relative(url: str) -> str:
	"""``https://site/files/x.png`` -> ``/files/x.png``; anything external is left alone."""
	site = frappe.utils.get_url()
	return url[len(site) :] if site and url.startswith(site) else url


def _mark_svg(brand: dict[str, Any]) -> str:
	wordmark = str(brand.get("wordmark_text") or brand.get("brand_name") or "").strip()
	initial = (wordmark[:1] or "•").upper()
	# Monolith Gold, the design system every surface already uses.
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" '
		f'aria-label="{frappe.utils.escape_html(wordmark)}">'
		'<rect width="64" height="64" rx="10" fill="#0B0B0A"/>'
		'<text x="32" y="45" text-anchor="middle" font-family="Unbounded, Arial Black, Arial, sans-serif" '
		f'font-weight="900" font-size="34" fill="#C9A96E">{frappe.utils.escape_html(initial)}</text>'
		"</svg>"
	)


def _ensure_generated_mark(brand: dict[str, Any]) -> str:
	"""Create / refresh the generated brand mark File. Idempotent: content-addressed by brand."""
	file_name = "awanz-brand-mark.svg"
	content = _mark_svg(brand)
	existing = frappe.db.get_value(
		"File", {"file_name": file_name, "is_private": 0}, ["name", "file_url"], as_dict=True
	)
	if existing:
		try:
			current = frappe.get_doc("File", existing.name)
			if (current.get_content() or "") != content:
				current.save_file(content=content, overwrite=True)
				current.db_set("file_url", current.file_url, update_modified=False)
			return current.file_url
		except Exception:
			# unreadable / detached file row — fall through and make a new one
			frappe.db.delete("File", {"name": existing.name})

	doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": file_name,
			"is_private": 0,
			"content": content,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	return doc.file_url


def _wordmark_html(brand: dict[str, Any]) -> str:
	"""``brand_html`` for the website navbar — the tenant's wordmark, never the Frappe logo."""
	wordmark = str(brand.get("wordmark_text") or brand.get("brand_name") or "").strip()
	sub = str(brand.get("sub_mark") or "").strip()
	logo = _stored_brand_logo() or brand.get("brand_logo")
	if logo:
		return (
			f'<img src="{_relative(str(logo))}" alt="{frappe.utils.escape_html(wordmark)}" '
			'class="awanz-wordmark-logo" style="max-height:28px">'
		)
	out = (
		'<span class="awanz-wordmark" style="font-family:Unbounded,\'Arial Black\',sans-serif;'
		'font-weight:900;letter-spacing:.22em">'
		f"{frappe.utils.escape_html(wordmark)}</span>"
	)
	if sub:
		out += (
			'<small class="awanz-submark" style="display:block;font-size:9px;letter-spacing:.28em;'
			f'opacity:.6">{frappe.utils.escape_html(sub)}</small>'
		)
	return out


def developer_credit(brand: dict[str, Any]) -> str:
	"""``Powered by <developer>`` — who built the platform, linked when a site is configured.

	Brand-driven (``AWANZ POS Settings.developer_name`` / ``developer_website``) so every
	tenant of this platform carries the credit without a code change, and clearing the field
	removes it entirely.
	"""
	name = str(brand.get("developer_name") or "").strip()
	if not name:
		return ""
	label = frappe.utils.escape_html(name)
	site = str(brand.get("developer_website") or "").strip()
	if site:
		label = (
			f'<a class="awanz-dev-credit" href="{frappe.utils.escape_html(site)}" '
			f'target="_blank" rel="noreferrer noopener">{label}</a>'
		)
	return f"Powered by {label}"


def _powered_html(brand: dict[str, Any]) -> str:
	"""The footer line that replaces "Powered by ERPNext": the tenant's product, then the
	developer credit."""
	product = str(brand.get("product_name") or brand.get("brand_name") or "").strip()
	website = str(brand.get("brand_website") or "").strip()
	credit = developer_credit(brand)
	if product:
		if website:
			product_html = (
				f'<a class="text-muted" href="{frappe.utils.escape_html(website)}" '
				f'target="_blank" rel="noreferrer">{frappe.utils.escape_html(product)}</a>'
			)
		else:
			product_html = f'<span class="text-muted">{frappe.utils.escape_html(product)}</span>'
	else:
		product_html = ""
	parts = [p for p in (product_html, credit) if p]
	if not parts:
		return " "  # a single space still counts as "set", so the ERPNext include never runs
	return '<span class="text-muted">' + " &middot; ".join(parts) + "</span>"


def _scrubbed_banner() -> str:
	"""``Website Settings.banner_html`` is free-form tenant content: leave whatever the client
	wrote, and clear it only when it is the framework's own banner."""
	try:
		current = frappe.db.get_single_value("Website Settings", "banner_html") or ""
	except Exception:
		return ""
	return "" if FRAMEWORK_WORD.search(current) else current


def desired_values(brand: Optional[dict[str, Any]] = None) -> dict[str, dict[str, Any]]:
	"""Every settings value this release drives from the brand. Read-only — no writes."""
	b = brand or _brand()
	mark = brand_mark_url(b)
	legal = str(b.get("legal_name") or b.get("brand_name") or "").strip()
	support = str(b.get("support_email") or "").strip()
	year = now_datetime().year
	address_lines = [line for line in (legal, support) if line]

	return {
		"Website Settings": {
			"app_name": b["brand_name"],
			"title_prefix": b["brand_name"],
			"brand_html": _wordmark_html(b),
			"app_logo": mark,
			"favicon": mark,
			"splash_image": mark,
			"footer_logo": mark,
			"copyright": f"{year} {legal}" if legal else str(b["brand_name"]),
			"footer_powered": _powered_html(b),
			# ERPNext's "Get Updates" block ships `erpnext.subscribe_to_newsletter` inline
			"hide_footer_signup": 1,
			"banner_html": _scrubbed_banner(),
		},
		"System Settings": {
			# desk browser tab + notification subject fallback (ships as "ERPNext")
			"app_name": b["brand_name"],
			# kills ERPNext's `default_mail_footer` — "Sent via ERPNext"
			"disable_standard_email_footer": 1,
			"email_footer_address": "\n".join(address_lines),
			# the name a staff member's authenticator app shows for this site (ships as
			# "Frappe Framework"): a 2FA enrolment is a product surface too
			"otp_issuer_name": b["brand_name"],
			# ERPNext's getting-started widget on the desk Home workspace reads "Let's begin your
			# journey with ERPNext" and every step is ERPNext tutorial prose. It is upstream's
			# onboarding for upstream's product, not the tenant's; a delivered site does not show
			# it. `revert_whitelabel()` turns it back on.
			"enable_onboarding": 0,
		},
	}


# ---------------------------------------------------------------------------
# apply / revert
# ---------------------------------------------------------------------------
def _read_backup() -> dict[str, Any]:
	raw = frappe.db.get_global(BACKUP_KEY)
	if not raw:
		return {}
	try:
		return json.loads(raw)
	except Exception:
		return {}


def _write_backup(data: dict[str, Any]) -> None:
	frappe.db.set_global(BACKUP_KEY, json.dumps(data))


def _snapshot() -> dict[str, Any]:
	"""Current values of everything we are about to overwrite (once, on first apply)."""
	ws = frappe.get_single("Website Settings")
	snap: dict[str, Any] = {
		"version": VERSION,
		"Website Settings": {k: ws.get(k) for k in WEBSITE_KEYS},
		"System Settings": {k: frappe.db.get_single_value("System Settings", k) for k in SYSTEM_KEYS},
		"navbar": {},
		"workspaces": {},
	}
	if frappe.db.exists("DocType", "Workspace"):
		snap["workspaces"] = {
			row.name: row.title
			for row in frappe.get_all("Workspace", fields=["name", "title"], limit=0)
			if row.title and FRAMEWORK_WORD.search(row.title)
		}
	if frappe.db.exists("DocType", "Navbar Settings"):
		nb = frappe.get_single("Navbar Settings")
		snap["navbar"] = {
			"app_logo": nb.get("app_logo"),
			"help_dropdown": {
				row.item_label: {"hidden": cint(row.hidden), "route": row.route}
				for row in (nb.get("help_dropdown") or [])
			},
		}
	return snap


# --- v0.8 QA U1 — keep the stored footer line current on an already-white-labelled site --------
#
# `/login` and every standard web page render `Website Settings.footer_powered`, which
# `apply_whitelabel` *stores*: a site white-labelled before the developer credit existed kept the
# old line for ever ("AWANZ POS by CloudChaserz" — no "Powered by", no developer), which is why
# QA found the credit missing on the whole customer-facing website. Only sites that already opted
# into the white-label (a backup snapshot exists) are touched — this never white-labels a site by
# itself.
# ------------------------------------------------------------------------------------------------
def refresh_footer_credit() -> dict[str, Any]:
	"""Re-assert the footer line from the current brand. Idempotent; no-op before `apply_whitelabel`."""
	try:
		if not _read_backup():
			return {"skipped": "white-label not applied"}
		desired = _powered_html(_brand())
		if (frappe.db.get_single_value("Website Settings", "footer_powered") or "") == desired:
			return {"changed": False}
		frappe.db.set_single_value("Website Settings", "footer_powered", desired)
		frappe.clear_cache()
		return {"changed": True}
	except Exception:  # pragma: no cover - never break a migrate over a footer line
		frappe.log_error(frappe.get_traceback(), "awanz footer credit refresh")
		return {"error": True}
# --- end v0.8 QA U1 ---


def _apply_website_settings(values: dict[str, Any]) -> list[str]:
	changed: list[str] = []
	doc = frappe.get_single("Website Settings")
	for key, value in values.items():
		if (doc.get(key) or "") == (value or ""):
			continue
		doc.set(key, value)
		changed.append(key)
	if changed:
		doc.flags.ignore_permissions = True
		doc.flags.ignore_mandatory = True
		doc.save(ignore_permissions=True)
	return changed


def _apply_system_settings(values: dict[str, Any]) -> list[str]:
	"""Singles row *and* ``tabDefaultValue`` — the mail footer is read through ``get_default``."""
	changed: list[str] = []
	for key, value in values.items():
		if (frappe.db.get_single_value("System Settings", key) or "") == (value or ""):
			continue
		frappe.db.set_single_value("System Settings", key, value)
		changed.append(key)
	# always (re)assert the defaults: `frappe.db.get_default` is a separate table
	for key, value in values.items():
		frappe.db.set_default(key, value)
	if changed:
		frappe.cache.delete_value("system_settings")
	return changed


def _apply_navbar(brand: dict[str, Any], mark: str) -> list[str]:
	if not frappe.db.exists("DocType", "Navbar Settings"):
		return []
	changed: list[str] = []
	nb = frappe.get_single("Navbar Settings")
	if (nb.get("app_logo") or "") != mark:
		nb.app_logo = mark
		changed.append("app_logo")

	support = str(brand.get("support_email") or "").strip()
	website = str(brand.get("brand_website") or "").strip()
	support_label = f"{brand['brand_name']} {SUPPORT_ITEM_LABEL_SUFFIX}"

	for row in nb.get("help_dropdown") or []:
		if row.item_label not in FRAMEWORK_HELP_ITEMS:
			continue
		if not cint(row.hidden):
			row.hidden = 1
			changed.append(f"help:{row.item_label}")
		# a hidden row still ships its URL in `frappe.boot`, which the desk page serves as
		# plain text — blank it so view-source carries no frappe.io / erpnext.com either
		if row.route:
			row.route = ""
			changed.append(f"help-route:{row.item_label}")

	labels = {row.item_label for row in (nb.get("help_dropdown") or [])}
	target = f"mailto:{support}" if support else website
	if target and support_label not in labels:
		nb.append(
			"help_dropdown",
			{"item_label": support_label, "item_type": "Route", "route": target, "is_standard": 0, "hidden": 0},
		)
		changed.append(f"help:+{support_label}")

	if changed:
		nb.flags.ignore_permissions = True
		nb.flags.in_patch = True  # standard rows are only hidden, never removed; skip the count guard
		nb.save(ignore_permissions=True)
	return changed


@frappe.whitelist()
def apply_whitelabel() -> dict[str, Any]:
	"""Push the current brand settings onto every Frappe/ERPNext surface. Idempotent.

	Safe to re-run: only values that actually differ are written, and the pre-white-label
	snapshot is taken exactly once so a later :func:`revert_whitelabel` restores the site.
	"""
	_require_system_manager()
	return _apply()


def _apply() -> dict[str, Any]:
	brand = _brand()
	values = desired_values(brand)

	backup = _read_backup()
	if not backup:
		backup = _snapshot()
		_write_backup(backup)

	changed = {
		"Website Settings": _apply_website_settings(values["Website Settings"]),
		"System Settings": _apply_system_settings(values["System Settings"]),
		"Navbar Settings": _apply_navbar(brand, values["Website Settings"]["app_logo"]),
		"Workspace": _apply_workspace_titles(brand),
	}
	frappe.cache.delete_value(PRODUCT_NAME_CACHE_KEY)
	frappe.cache.delete_value(BRAND_MARK_CACHE_KEY)
	frappe.clear_cache()
	return {
		"ok": True,
		"brand": brand["brand_name"],
		"product_name": brand["product_name"],
		"changed": changed,
		"already_applied": not any(changed.values()),
	}


def workspace_title(brand: dict[str, Any], title: str, taken: set[str]) -> str:
	"""``"Frappe CRM"`` -> ``"CRM"``, or ``"<brand> CRM"`` when a workspace already owns "CRM"."""
	stripped = FRAMEWORK_WORD.sub("", title).strip(" -–—·")
	stripped = re.sub(r"\s{2,}", " ", stripped)
	if stripped and stripped.lower() not in taken:
		return stripped
	return f"{brand['brand_name']} {stripped}".strip()


def _apply_workspace_titles(brand: dict[str, Any]) -> list[str]:
	"""Rewrite desk sidebar titles that name the framework. Idempotent, and re-run after migrate
	because Frappe re-imports the standard workspaces from each app's JSON."""
	if not frappe.db.exists("DocType", "Workspace"):
		return []
	rows = frappe.get_all("Workspace", fields=["name", "title", "label"], limit=0)
	changed: list[str] = []
	for row in rows:
		title = row.title or row.label or ""
		if not FRAMEWORK_WORD.search(title):
			continue
		taken = {(r.title or r.label or "").lower() for r in rows if r.name != row.name}
		new_title = workspace_title(brand, title, taken)
		if new_title and new_title != title:
			frappe.db.set_value("Workspace", row.name, "title", new_title, update_modified=False)
			changed.append(f"{row.name} -> {new_title}")
	if changed:
		frappe.cache.delete_value("workspace_sidebar_items")
	return changed


@frappe.whitelist()
def revert_whitelabel() -> dict[str, Any]:
	"""Put back exactly what was there before the first :func:`apply_whitelabel`."""
	_require_system_manager()
	backup = _read_backup()
	if not backup:
		return {"ok": True, "reverted": False, "reason": "no snapshot — white-label was never applied"}

	ws = frappe.get_single("Website Settings")
	for key, value in (backup.get("Website Settings") or {}).items():
		ws.set(key, value)
	ws.flags.ignore_permissions = True
	ws.flags.ignore_mandatory = True
	ws.save(ignore_permissions=True)

	for key, value in (backup.get("System Settings") or {}).items():
		frappe.db.set_single_value("System Settings", key, value)
		frappe.db.set_default(key, value)
	frappe.cache.delete_value("system_settings")

	nav = backup.get("navbar") or {}
	if nav and frappe.db.exists("DocType", "Navbar Settings"):
		nb = frappe.get_single("Navbar Settings")
		nb.app_logo = nav.get("app_logo")
		previous = nav.get("help_dropdown") or {}
		keep = []
		for row in nb.get("help_dropdown") or []:
			if row.item_label in previous:
				before = previous[row.item_label]
				if isinstance(before, dict):
					row.hidden = cint(before.get("hidden"))
					row.route = before.get("route")
				else:  # snapshot written by an earlier point release
					row.hidden = cint(before)
				keep.append(row)
			elif cint(row.get("is_standard")):
				keep.append(row)
			# else: an item we added (the tenant support link) — dropped
		nb.set("help_dropdown", keep)
		nb.flags.ignore_permissions = True
		nb.flags.in_patch = True
		nb.save(ignore_permissions=True)

	for name, title in (backup.get("workspaces") or {}).items():
		if frappe.db.exists("Workspace", name):
			frappe.db.set_value("Workspace", name, "title", title, update_modified=False)

	frappe.db.set_global(BACKUP_KEY, None)
	frappe.cache.delete_value(PRODUCT_NAME_CACHE_KEY)
	frappe.cache.delete_value(BRAND_MARK_CACHE_KEY)
	frappe.clear_cache()
	return {"ok": True, "reverted": True}


@frappe.whitelist()
def whitelabel_status() -> dict[str, Any]:
	"""Read-only: what is set now vs. what the brand says it should be."""
	_require_system_manager()
	brand = _brand()
	values = desired_values(brand)
	ws = frappe.get_single("Website Settings")
	current = {
		"Website Settings": {k: ws.get(k) for k in values["Website Settings"]},
		"System Settings": {
			k: frappe.db.get_single_value("System Settings", k) for k in values["System Settings"]
		},
	}
	drift = {
		dt: [k for k, v in want.items() if (current[dt].get(k) or "") != (v or "")]
		for dt, want in values.items()
	}
	return {
		"applied": bool(_read_backup()),
		"brand": brand["brand_name"],
		"expected": values,
		"current": current,
		"drift": drift,
		"ok": not any(drift.values()),
	}


def _require_system_manager() -> None:
	if frappe.session.user == "Administrator":
		return
	if "System Manager" not in frappe.get_roles():
		frappe.throw(
			frappe._("Only a System Manager may change the white-label settings."), frappe.PermissionError
		)


# ---------------------------------------------------------------------------
# hooks
# ---------------------------------------------------------------------------
def website_context(context) -> dict[str, Any]:
	"""``update_website_context`` — runs after every www page's own ``get_context``.

	Keeps the brand on pages we do not own (``/login``, ``/404``, webshop, portal) and drops
	the framework's own call-to-actions.
	"""
	out: dict[str, Any] = {
		# "Login with Frappe Cloud" (frappe/www/login.html) — never on a white-labelled site
		"login_with_frappe_cloud_url": None,
	}
	try:
		brand = _live_brand()
	except Exception:
		return out

	# These only fire before `apply_whitelabel()` has run (afterwards Website Settings carries the
	# mark, so the framework asset never reaches the context) or if a tenant clears the fields.
	# The URL is cached: this hook runs on every website request.
	mark = context.get("favicon")
	if not mark or _is_framework_asset(mark):
		out["favicon"] = _cached_mark_url(brand)
	splash = context.get("splash_image")
	if not splash or _is_framework_asset(splash):
		out["splash_image"] = _cached_mark_url(brand)
	logo = context.get("logo")
	if logo and _is_framework_asset(logo):
		out["logo"] = _cached_mark_url(brand)

	out["app_name"] = context.get("app_name") or brand["brand_name"]
	out["awanz_brand"] = brand

	# `Website Settings.title_prefix` puts the tenant on the <title> of every page the framework
	# renders ("CloudChaserz - Login"). Frappe applies it just before this hook runs, and only
	# skips pages whose title *starts* with the prefix — so a page we own whose title already
	# carries the brand later in the string ("AWANZ POS by CloudChaserz") comes out doubled.
	prefix = str(context.get("title_prefix") or "")
	if not prefix:
		prefix = str(brand["brand_name"])
		out["title_prefix"] = prefix
		title = str(context.get("title") or "")
		if title and not title.startswith(prefix):
			context.title = f"{prefix} - {title}"
			out["title"] = context.title
	title = str(context.get("title") or "")
	separator = f"{prefix} - "
	if prefix and title.startswith(separator):
		rest = title[len(separator) :]
		if prefix.lower() in rest.lower():
			out["title"] = rest
	return out


def _is_framework_asset(url: Any) -> bool:
	return "/assets/frappe/" in str(url) or "/assets/erpnext/" in str(url)


def _cached_mark_url(brand: dict[str, Any]) -> str:
	"""``brand_mark_url`` for the request hooks: cached, and never fatal."""
	try:
		cached = frappe.cache.get_value(BRAND_MARK_CACHE_KEY)
		if cached:
			return str(cached)
		url = brand_mark_url(brand)
		frappe.cache.set_value(BRAND_MARK_CACHE_KEY, url)
		return url
	except Exception:
		return FALLBACK_MARK


def extend_bootinfo(bootinfo) -> None:
	"""``extend_bootinfo`` — brand tokens for the desk chrome (``public/js/awanz-desk.js``)."""
	try:
		bootinfo.awanz_brand = _live_brand()
	except Exception:
		bootinfo.awanz_brand = {}


def scrub_response(response=None, request=None) -> None:
	"""``after_request`` — the last two framework strings, and the framework headers.

	``<!-- Built on Frappe … -->`` and ``<meta name="generator" content="frappe">`` sit outside
	every Jinja block in ``frappe/templates/base.html``, so a template override cannot reach
	them without forking the whole file. Two literal byte replacements are cheaper and survive
	upstream edits elsewhere in that template.
	"""
	if response is None:
		return
	try:
		headers = getattr(response, "headers", None)
		if headers is not None:
			for key in [k for k in headers.keys() if k.lower().startswith("x-frappe-")]:
				value = headers.get(key)
				del headers[key]
				headers["X-Request-Id" if key.lower() == "x-frappe-request-id" else "X-" + key[10:]] = value
			headers["Server"] = _server_token()

		if not getattr(response, "direct_passthrough", False) and "html" in (
			getattr(response, "mimetype", "") or ""
		):
			body = response.get_data()
			if _GENERATOR_META in body or _BUILT_ON_COMMENT in body:
				product = _server_token().encode("utf-8")
				body = body.replace(_GENERATOR_META, b'<meta name="generator" content="' + product + b'">')
				body = body.replace(_BUILT_ON_COMMENT, b"<!-- " + product + b" -->")
				response.set_data(body)
	except Exception:
		# never let branding break a response
		frappe.logger().debug("awanz white-label response scrub failed", exc_info=True)


def _server_token() -> str:
	"""The product name, cached in redis: ``scrub_response`` runs on *every* response, and a
	database round trip per request to brand a header would be a poor trade."""
	try:
		cached = frappe.cache.get_value(PRODUCT_NAME_CACHE_KEY)
		if cached:
			return str(cached)
		brand = _live_brand()
		name = str(brand.get("product_name") or brand.get("brand_name") or FALLBACK_PRODUCT_NAME)
		frappe.cache.set_value(PRODUCT_NAME_CACHE_KEY, name)
		return name
	except Exception:
		return FALLBACK_PRODUCT_NAME


def scrub_email_headers(email) -> None:
	"""``make_email_body_message`` — ``X-Frappe-Site`` on every outgoing message becomes ours."""
	try:
		site_url = frappe.utils.get_url()
		if "X-Frappe-Site" in email.msg_root:
			del email.msg_root["X-Frappe-Site"]
		if "X-AWANZ-Site" in email.msg_root:
			del email.msg_root["X-AWANZ-Site"]
		email.msg_root["X-AWANZ-Site"] = site_url
	except Exception:
		frappe.logger().debug("awanz white-label email header scrub failed", exc_info=True)


# ---------------------------------------------------------------------------
# honesty: the attribution the licences require, out of the marketing chrome
# ---------------------------------------------------------------------------
@frappe.whitelist()
def attribution() -> dict[str, Any]:
	"""Installed open-source components and their licences.

	White-labelling removes upstream *marketing* from the UI; it does not remove the notices the
	licences require. Those live in each app's ``LICENSE`` file and source headers, and this
	endpoint surfaces them in the product (the desk About dialog links here).
	"""
	from frappe.utils.change_log import get_versions

	known_licences = {
		"frappe": "MIT",
		"erpnext": "GNU General Public License v3",
		"payments": "MIT",
		"webshop": "GNU General Public License v3",
		"hrms": "GNU General Public License v3",
		"crm": "GNU Affero General Public License v3",
		"maison_pos": "MIT",
	}
	components = []
	for app, info in (get_versions() or {}).items():
		components.append(
			{
				"app": app,
				"title": info.get("title") or app,
				"version": info.get("branch_version") or info.get("version"),
				"licence": known_licences.get(app, "see the app's LICENSE file"),
			}
		)
	brand = _brand()
	return {
		"product": brand["product_name"],
		"brand": brand["brand_name"],
		"notice": (
			"This product is built on open-source components. Their copyright notices and licence "
			"texts are distributed with the software (each app's LICENSE file and source headers) "
			"and are not removed by branding."
		),
		"components": sorted(components, key=lambda c: c["app"]),
	}


# ---------------------------------------------------------------------------
# install glue
# ---------------------------------------------------------------------------
def setup_whitelabel() -> None:
	"""Called from ``after_install`` / ``after_migrate``. Never blocks the migration."""
	try:
		_apply()
	except Exception:
		frappe.log_error(title="maison_pos white-label setup failed")
