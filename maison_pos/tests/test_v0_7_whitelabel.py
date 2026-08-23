"""v0.7 — the product surface never says "Frappe" or "ERPNext", and every value is brand-driven.

Covers ``maison_pos.setup.whitelabel``:

* **brand-driven** — nothing is hard-coded: change the brand settings and every derived value
  follows, on the jewellery tenant as much as on CloudChaserz;
* **idempotent** — a second ``apply_whitelabel()`` writes nothing and ``whitelabel_status()``
  reports no drift, which is what makes it safe on every ``bench migrate``;
* **reversible** — ``revert_whitelabel()`` puts back exactly the values that were there before;
* the request/response and e-mail hooks, the template overrides, and the attribution endpoint
  that deliberately *keeps* naming the upstream projects.
"""

from __future__ import annotations

import json

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import cint
from werkzeug.wrappers import Response

from maison_pos import brand as brand_module
from maison_pos.api import pwa
from maison_pos.setup import whitelabel

SETTINGS = "Maison POS Settings"
BRAND_FIELDS = (
	"brand_name",
	"product_name",
	"tagline",
	"wordmark_text",
	"sub_mark",
	"legal_name",
	"support_email",
	"brand_website",
	"brand_logo",
)


def _brand_settings() -> dict:
	return {f: frappe.db.get_single_value(SETTINGS, f) for f in BRAND_FIELDS}


def _write_brand(values: dict) -> None:
	for key, value in values.items():
		frappe.db.set_single_value(SETTINGS, key, value)
	brand_module.clear_brand_cache()
	frappe.clear_cache()


class TestWhiteLabel(FrappeTestCase):
	"""Every assertion is written against the *current* brand, never against a literal name."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls._brand_before = _brand_settings()
		cls._backup_before = frappe.db.get_global(whitelabel.BACKUP_KEY)
		cls._ws_before = {k: frappe.get_single("Website Settings").get(k) for k in whitelabel.WEBSITE_KEYS}
		cls._ss_before = {
			k: frappe.db.get_single_value("System Settings", k) for k in whitelabel.SYSTEM_KEYS
		}

	@classmethod
	def tearDownClass(cls):
		_write_brand(cls._brand_before)
		ws = frappe.get_single("Website Settings")
		for key, value in cls._ws_before.items():
			ws.set(key, value)
		ws.flags.ignore_permissions = True
		ws.flags.ignore_mandatory = True
		ws.save(ignore_permissions=True)
		for key, value in cls._ss_before.items():
			frappe.db.set_single_value("System Settings", key, value)
			frappe.db.set_default(key, value)
		frappe.db.set_global(whitelabel.BACKUP_KEY, cls._backup_before)
		frappe.db.commit()
		frappe.clear_cache()
		super().tearDownClass()

	def setUp(self):
		brand_module.clear_brand_cache()

	# ------------------------------------------------------------------ brand-driven
	def test_desired_values_follow_the_brand_settings(self):
		"""No tenant name lives in the code: rewrite the settings, the surfaces follow."""
		brand = whitelabel._brand()
		values = whitelabel.desired_values(brand)
		web = values["Website Settings"]
		system = values["System Settings"]

		self.assertEqual(web["app_name"], brand["brand_name"])
		self.assertEqual(web["title_prefix"], brand["brand_name"])
		self.assertEqual(system["app_name"], brand["brand_name"])
		self.assertEqual(system["otp_issuer_name"], brand["brand_name"])
		self.assertIn(brand["wordmark_text"], web["brand_html"])
		self.assertIn(brand["product_name"], web["footer_powered"])
		self.assertIn(brand["legal_name"], web["copyright"])
		self.assertIn(brand["support_email"], system["email_footer_address"])
		self.assertEqual(web["hide_footer_signup"], 1)
		self.assertEqual(system["disable_standard_email_footer"], 1)
		# ERPNext's getting-started widget ("Let's begin your journey with ERPNext") is upstream's
		# onboarding for upstream's product
		self.assertEqual(system["enable_onboarding"], 0)

		blob = json.dumps(values)
		for framework in ("Frappe", "ERPNext", "frappe.io", "erpnext.com"):
			self.assertNotIn(framework, blob, f"{framework} leaked into the white-label values")

	def test_a_different_tenant_gets_different_values(self):
		"""The jewellery tenant and a made-up one both come out right, with no code change."""
		before = _brand_settings()
		try:
			_write_brand(
				{
					"brand_name": "Vandermeer",
					"product_name": "Vandermeer Retail",
					"wordmark_text": "VANDERMEER",
					"sub_mark": "Retail",
					"legal_name": "Vandermeer Holdings BV",
					"support_email": "help@vandermeer.example",
					"brand_website": "https://vandermeer.example",
				}
			)
			values = whitelabel.desired_values()
			self.assertEqual(values["Website Settings"]["app_name"], "Vandermeer")
			self.assertIn("VANDERMEER", values["Website Settings"]["brand_html"])
			self.assertIn("Vandermeer Retail", values["Website Settings"]["footer_powered"])
			self.assertIn("Vandermeer Holdings BV", values["Website Settings"]["copyright"])
			self.assertEqual(values["System Settings"]["otp_issuer_name"], "Vandermeer")
			self.assertNotIn(before["brand_name"], json.dumps(values))
		finally:
			_write_brand(before)

	def test_generated_mark_uses_the_brand_initial(self):
		before = _brand_settings()
		try:
			_write_brand({"wordmark_text": "ZENITH", "brand_logo": None})
			svg = whitelabel._mark_svg(whitelabel._brand())
			self.assertIn(">Z<", svg)
			self.assertNotIn("frappe", svg.lower())
			url = whitelabel.brand_mark_url()
			self.assertTrue(url.startswith("/files/"), url)
		finally:
			_write_brand(before)

	def test_uploaded_logo_wins_over_the_generated_mark(self):
		before = _brand_settings()
		try:
			_write_brand({"brand_logo": "/files/tenant-logo.png"})
			self.assertEqual(whitelabel.brand_mark_url(), "/files/tenant-logo.png")
			values = whitelabel.desired_values()
			self.assertEqual(values["Website Settings"]["favicon"], "/files/tenant-logo.png")
			self.assertIn("/files/tenant-logo.png", values["Website Settings"]["brand_html"])
		finally:
			_write_brand(before)

	# ------------------------------------------------------------------ idempotency
	def test_banner_html_is_the_tenants_to_keep(self):
		"""Free-form content the client wrote survives; the framework's own banner does not."""
		ws = frappe.get_single("Website Settings")
		before = ws.banner_html
		try:
			ws.banner_html = "<p>Store closed Monday</p>"
			ws.flags.ignore_permissions = True
			ws.save(ignore_permissions=True)
			self.assertEqual(
				whitelabel.desired_values()["Website Settings"]["banner_html"],
				"<p>Store closed Monday</p>",
			)

			ws.banner_html = '<p>Powered by <a href="https://frappe.io/erpnext">ERPNext</a></p>'
			ws.save(ignore_permissions=True)
			self.assertEqual(whitelabel.desired_values()["Website Settings"]["banner_html"], "")
		finally:
			ws.banner_html = before
			ws.save(ignore_permissions=True)

	def test_apply_is_idempotent(self):
		first = whitelabel._apply()
		second = whitelabel._apply()
		self.assertTrue(first["ok"])
		self.assertTrue(second["ok"])
		self.assertTrue(second["already_applied"], second["changed"])
		for changes in second["changed"].values():
			self.assertEqual(changes, [])

		status = whitelabel.whitelabel_status()
		self.assertTrue(status["ok"], status["drift"])
		self.assertTrue(status["applied"])

	def test_apply_puts_the_values_on_the_real_settings(self):
		whitelabel._apply()
		brand = whitelabel._brand()
		self.assertEqual(frappe.get_single("Website Settings").app_name, brand["brand_name"])
		self.assertEqual(frappe.get_single("Website Settings").title_prefix, brand["brand_name"])
		self.assertEqual(
			frappe.db.get_single_value("System Settings", "app_name"), brand["brand_name"]
		)
		# the mail footer is read through `frappe.db.get_default`, a different table
		self.assertEqual(cint(frappe.db.get_default("disable_standard_email_footer")), 1)
		self.assertIn(brand["support_email"], frappe.db.get_default("email_footer_address"))

	def test_navbar_help_links_to_the_framework_are_hidden_and_blanked(self):
		if not frappe.db.exists("DocType", "Navbar Settings"):
			self.skipTest("Navbar Settings not installed")
		whitelabel._apply()
		navbar = frappe.get_single("Navbar Settings")
		for row in navbar.help_dropdown:
			if row.item_label in whitelabel.FRAMEWORK_HELP_ITEMS:
				self.assertTrue(row.hidden, f"{row.item_label} still shown in the Help menu")
				self.assertFalse(row.route, f"{row.item_label} still ships {row.route} in frappe.boot")
		labels = [r.item_label for r in navbar.help_dropdown]
		brand = whitelabel._brand()
		self.assertIn(f"{brand['brand_name']} {whitelabel.SUPPORT_ITEM_LABEL_SUFFIX}", labels)

	def test_workspace_titles_lose_the_framework_name(self):
		"""The desk sidebar reads `Workspace.title`; "Frappe CRM" must not be in it."""
		brand = whitelabel._brand()
		# no collision -> the framework word is simply dropped
		self.assertEqual(whitelabel.workspace_title(brand, "ERPNext Settings", set()), "Settings")
		# collision with an existing workspace -> qualified with the tenant, never left as-is
		taken = {"crm", "integrations"}
		self.assertEqual(
			whitelabel.workspace_title(brand, "Frappe CRM", taken), f"{brand['brand_name']} CRM"
		)
		self.assertEqual(
			whitelabel.workspace_title(brand, "ERPNext Integrations", taken),
			f"{brand['brand_name']} Integrations",
		)
		for title in ("ERPNext Settings", "Frappe CRM", "ERPNext Integrations"):
			out = whitelabel.workspace_title(brand, title, taken)
			self.assertNotIn("Frappe", out)
			self.assertNotIn("ERPNext", out)

	def test_apply_relabels_the_desk_workspaces(self):
		if not frappe.db.exists("DocType", "Workspace"):
			self.skipTest("Workspace not installed")
		whitelabel._apply()
		left = [
			row.title
			for row in frappe.get_all("Workspace", fields=["title"], limit=0)
			if row.title and whitelabel.FRAMEWORK_WORD.search(row.title)
		]
		self.assertEqual(left, [], f"desk sidebar still names the framework: {left}")

	# ------------------------------------------------------------------ revert
	def test_revert_restores_the_previous_values(self):
		marker = "https://example.invalid/before"
		ws = frappe.get_single("Website Settings")
		ws.app_name = "Before White Label"
		ws.footer_powered = marker
		ws.flags.ignore_permissions = True
		ws.save(ignore_permissions=True)
		frappe.db.set_single_value("System Settings", "app_name", "Before White Label")
		frappe.db.set_global(whitelabel.BACKUP_KEY, None)  # force a fresh snapshot
		frappe.clear_cache()

		whitelabel._apply()
		self.assertNotEqual(frappe.get_single("Website Settings").app_name, "Before White Label")

		result = whitelabel.revert_whitelabel()
		self.assertTrue(result["reverted"])
		restored = frappe.get_single("Website Settings")
		self.assertEqual(restored.app_name, "Before White Label")
		self.assertEqual(restored.footer_powered, marker)
		self.assertEqual(frappe.db.get_single_value("System Settings", "app_name"), "Before White Label")
		self.assertFalse(whitelabel._read_backup())

		# and re-applying afterwards still works
		again = whitelabel._apply()
		self.assertTrue(again["ok"])

	def test_revert_without_a_snapshot_is_a_no_op(self):
		frappe.db.set_global(whitelabel.BACKUP_KEY, None)
		result = whitelabel.revert_whitelabel()
		self.assertTrue(result["ok"])
		self.assertFalse(result["reverted"])
		whitelabel._apply()

	def test_only_a_system_manager_may_apply_or_revert(self):
		frappe.set_user("Guest")
		try:
			with self.assertRaises(frappe.PermissionError):
				whitelabel.apply_whitelabel()
			with self.assertRaises(frappe.PermissionError):
				whitelabel.revert_whitelabel()
		finally:
			frappe.set_user("Administrator")

	# ------------------------------------------------------------------ hooks
	def test_website_context_drops_the_frappe_cloud_login(self):
		context = frappe._dict({"title": "Login", "favicon": "/assets/frappe/images/frappe-favicon.svg"})
		out = whitelabel.website_context(context)
		self.assertIsNone(out["login_with_frappe_cloud_url"])
		self.assertNotIn("/assets/frappe/", out["favicon"])
		self.assertEqual(out["app_name"], whitelabel._brand()["brand_name"])

	def test_website_context_does_not_double_the_brand_in_a_title(self):
		brand = whitelabel._brand()
		name = brand["brand_name"]
		doubled = frappe._dict({"title_prefix": name, "title": f"{name} - {brand['product_name']}"})
		self.assertEqual(whitelabel.website_context(doubled)["title"], brand["product_name"])

		plain = frappe._dict({"title_prefix": name, "title": f"{name} - Login"})
		self.assertNotIn("title", whitelabel.website_context(plain))

	def test_response_scrub_replaces_the_framework_strings_and_headers(self):
		html = (
			b'<!DOCTYPE html>\n<!-- Built on Frappe. https://frappeframework.com/ -->\n'
			b'<html><head><meta name="generator" content="frappe"></head><body>hi</body></html>'
		)
		response = Response(html, mimetype="text/html")
		response.headers["X-Frappe-Request-Id"] = "abc123"
		whitelabel.scrub_response(response=response, request=None)

		body = response.get_data()
		self.assertNotIn(b"Built on Frappe", body)
		self.assertNotIn(b'content="frappe"', body)
		self.assertIn(whitelabel._server_token().encode(), body)
		self.assertNotIn("X-Frappe-Request-Id", response.headers)
		self.assertEqual(response.headers.get("X-Request-Id"), "abc123")
		self.assertEqual(response.headers.get("Server"), whitelabel._server_token())

	def test_server_token_follows_the_brand_and_is_cached(self):
		"""The response hook runs on every request, so the product name is cached — and the cache
		is dropped by apply / revert so a rebrand shows up immediately."""
		frappe.cache.delete_value(whitelabel.PRODUCT_NAME_CACHE_KEY)
		self.assertEqual(whitelabel._server_token(), whitelabel._brand()["product_name"])
		self.assertEqual(
			frappe.cache.get_value(whitelabel.PRODUCT_NAME_CACHE_KEY),
			whitelabel._brand()["product_name"],
		)
		before = _brand_settings()
		try:
			_write_brand({"product_name": "Vandermeer Retail"})
			whitelabel._apply()  # drops the cache
			self.assertEqual(whitelabel._server_token(), "Vandermeer Retail")
		finally:
			_write_brand(before)
			whitelabel._apply()

	def test_response_scrub_leaves_non_html_alone_and_never_raises(self):
		payload = b'{"message":"pong"}'
		response = Response(payload, mimetype="application/json")
		whitelabel.scrub_response(response=response, request=None)
		self.assertEqual(response.get_data(), payload)
		whitelabel.scrub_response(response=None, request=None)  # must not raise
		whitelabel.scrub_response(response=object(), request=None)  # must not raise

	def test_email_headers_carry_no_framework_name(self):
		class _Fake:
			def __init__(self):
				self.msg_root = {"X-Frappe-Site": "https://old.example"}

			def __contains__(self, key):  # pragma: no cover - dict does the work
				return key in self.msg_root

		fake = _Fake()
		whitelabel.scrub_email_headers(fake)
		self.assertNotIn("X-Frappe-Site", fake.msg_root)
		self.assertIn("X-Maison-Site", fake.msg_root)

	def test_bootinfo_carries_the_brand_for_the_desk(self):
		boot = frappe._dict()
		whitelabel.extend_bootinfo(boot)
		self.assertEqual(boot.maison_brand["brand_name"], whitelabel._brand()["brand_name"])

	# ------------------------------------------------------------------ templates / pages
	def test_our_footer_overrides_shadow_the_erpnext_ones(self):
		"""Both are resolved from this app, and the ERPNext newsletter block renders nothing."""
		import os

		app_path = frappe.get_app_path("maison_pos")
		for name in ("footer_powered.html", "footer_extension.html"):
			path = os.path.join(app_path, "templates", "includes", "footer", name)
			self.assertTrue(os.path.exists(path), f"{name} override missing")
			resolved = frappe.get_jenv().get_template(f"templates/includes/footer/{name}").filename
			self.assertTrue(resolved.startswith(app_path), f"{name} resolves to {resolved}")

		extension = frappe.render_template("templates/includes/footer/footer_extension.html", {})
		self.assertEqual(extension.strip(), "")

		brand = whitelabel._brand()
		powered = frappe.render_template(
			"templates/includes/footer/footer_powered.html", {"maison_brand": brand}
		)
		self.assertIn(brand["product_name"], powered)
		for framework in ("Frappe", "ERPNext"):
			self.assertNotIn(framework, powered)

	def test_the_404_page_is_ours_and_carries_no_framework_asset(self):
		"""The framework 404 ships `/assets/frappe/images/ui-states/404.png`; ours ships the brand."""
		import os
		import re

		from maison_pos.www import error_404

		context = frappe._dict()
		error_404.get_context(context)
		brand = whitelabel._brand()
		self.assertEqual(context.brand_name, brand["brand_name"])
		self.assertEqual(context.wordmark, brand["wordmark_text"] or brand["brand_name"])
		self.assertEqual(context.support_email, brand["support_email"])

		path = os.path.join(frappe.get_app_path("maison_pos"), "www", "404.html")
		with open(path, encoding="utf-8") as f:
			markup = re.sub(r"\{#-?.*?-?#\}", "", f.read(), flags=re.S)  # drop our own comments
		self.assertNotIn("/assets/frappe/", markup)
		for framework in ("Frappe", "ERPNext"):
			self.assertNotIn(framework, markup)

	def test_pwa_manifest_is_brand_driven(self):
		payload = json.loads(pwa.manifest().get_data(as_text=True))
		brand = whitelabel._brand()
		self.assertEqual(payload["name"], brand["product_name"])
		self.assertEqual(payload["short_name"], brand["brand_name"])
		self.assertTrue(payload["icons"])

	def test_pos_shell_points_at_the_branded_manifest(self):
		from maison_pos.www import pos

		head = '<link rel="manifest" href="/assets/maison_pos/pos/manifest.webmanifest">'
		self.assertIn(pos.BRANDED_MANIFEST, pos._brand_manifest(head))
		self.assertNotIn("manifest.webmanifest", pos._brand_manifest(head))

	# ------------------------------------------------------------------ honesty
	def test_attribution_still_names_the_upstream_projects(self):
		"""White-labelling removes upstream marketing, never the licence notices."""
		data = whitelabel.attribution()
		apps = {c["app"] for c in data["components"]}
		self.assertIn("frappe", apps)
		self.assertIn("erpnext", apps)
		licences = {c["app"]: c["licence"] for c in data["components"]}
		self.assertIn("GNU", licences["erpnext"])
		self.assertEqual(data["product"], whitelabel._brand()["product_name"])
