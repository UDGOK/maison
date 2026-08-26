"""v1.2 — the socket.io namespace is the **site name**, not the host the browser is on.

The wall, the dashboard ticker and the Salon all connect to `<origin>/<namespace>`, and Frappe's
socketio server resolves that namespace to a site under `sites/`. `location.hostname` is the same
string as the site name on `<site>.frappe.cloud`, which is why the client's fallback worked for
ten releases and then silently stopped the day they pointed `www.cc-ok.com` at the site: socket.io
was asked for a namespace that does not exist, every connection failed its handshake, and every
screen dropped to its polling fallback with nothing a user could see except a `POLLING` pill.

The fix is that the page tells the client what the site is actually called. These tests assert the
pages carry it — the client-side half is pinned in `frontend/src/tests/salon.test.ts`.
"""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

#: every page that opens a socket, and the module that builds its context
PAGES = (
	("maison_pos.www.pos", "/pos"),
	("maison_pos.www.warehouse", "/warehouse"),
	("maison_pos.www.warehouse_wall", "/warehouse-wall"),
	("maison_pos.www.salon", "/salon"),
	("maison_pos.www.awanz_dashboard", "/awanz-dashboard"),
)


class TestRealtimeNamespace(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def _context(self, module: str) -> frappe._dict:
		"""Frappe's ``get_context`` mutates the dict it is handed and may return nothing."""
		context = frappe._dict()
		returned = frappe.get_attr(f"{module}.get_context")(context)
		return returned if isinstance(returned, dict) else context

	def test_every_page_that_opens_a_socket_names_the_site(self):
		for module, route in PAGES:
			with self.subTest(route=route):
				context = self._context(module)
				self.assertEqual(
					context.get("site_name"),
					frappe.local.site,
					f"{route} must tell the client the real site name, not leave it guessing from the URL",
				)

	def test_the_socket_port_and_dev_flag_travel_with_it(self):
		"""Without these the client guesses 9000 and assumes production, which is wrong under `bench serve`."""
		for module, route in PAGES:
			with self.subTest(route=route):
				context = self._context(module)
				self.assertIsNotNone(context.get("socketio_port"), f"{route} carries no socketio_port")
				self.assertIn(context.get("dev_server"), (0, 1), f"{route} carries no dev_server flag")

	def test_the_site_name_is_not_merely_the_host(self):
		"""The regression itself: a custom domain must not be able to stand in for the site name.

		`frappe.local.site` is the directory under `sites/`. If a future change ever resolves it
		from the request host instead, this fails — which is the whole point.
		"""
		context = self._context("maison_pos.www.warehouse")
		self.assertEqual(context.get("site_name"), frappe.local.site)
		self.assertNotIn("://", context.get("site_name") or "", "the namespace is a name, not a URL")

	def test_the_rendered_page_carries_it_into_the_browser(self):
		"""Context is not enough — the template has to emit it, which is where it was missed."""
		import os

		# `frappe.get_app_path` scrubs its joins (`-` becomes `_`), so build the path by hand —
		# `warehouse-wall.html` really does have a hyphen in it.
		www = os.path.join(frappe.get_app_path("maison_pos"), "www")
		for filename, route in (
			("warehouse.html", "/warehouse"),
			("warehouse-wall.html", "/warehouse-wall"),
			("pos.html", "/pos"),
			("salon.html", "/salon"),
		):
			with self.subTest(route=route):
				with open(os.path.join(www, filename), encoding="utf-8") as f:
					source = f.read()
				self.assertIn(
					"window.awanz_site_name",
					source,
					f"{route} builds its context but never hands the site name to the client",
				)
