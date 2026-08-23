"""v0.7 white-label — replace the framework's app picker with the tenant's launcher.

Frappe's ``/apps`` screen ("Select an app to continue") lists every installed app by its own
title — *ERPNext*, *Frappe HR*, *Frappe CRM* — which is the one desk screen that names the
framework to staff in plain English. Installed apps are searched in reverse install order, so
this module shadows ``frappe/www/apps.py`` and sends the user to ``/start`` instead: the branded
launcher that already lists exactly the screens their roles allow, the admin desk included.

Delete this file (and ``apps.html``) to get the framework's picker back.
"""

from __future__ import annotations

import frappe

no_cache = 1
sitemap = 0

LAUNCHER = "/start"


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/start"
		raise frappe.Redirect
	frappe.local.flags.redirect_location = LAUNCHER
	raise frappe.Redirect
