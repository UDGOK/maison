"""Serve the head-office live dashboard (built Vue app) at /maison-dashboard.

The Vite build lands in ``maison_pos/public/dashboard/index.html`` with asset
URLs rooted at ``/assets/maison_pos/dashboard/``.  We read the built shell and
inject its ``<head>`` (font links, module script, stylesheet) and ``<body>``
into the Jinja template, so the page is served by Frappe with session auth.
"""

from __future__ import annotations

import os
import re

import frappe
from frappe import _

no_cache = 1

ALLOWED_ROLES = {"Maison Head Office", "Maison Regional", "System Manager"}


def _check_access() -> None:
    """Require a logged-in user holding one of the dashboard roles."""
    if frappe.session.user in (None, "", "Guest"):
        frappe.throw(_("Please log in to view the Maison dashboard."), frappe.PermissionError)
    roles = set(frappe.get_roles(frappe.session.user))
    if not roles & ALLOWED_ROLES:
        frappe.throw(_("You do not have permission to view the Maison dashboard."), frappe.PermissionError)


def _built_index() -> str | None:
    """Return the built ``index.html`` contents, or ``None`` if not built."""
    path = frappe.get_app_path("maison_pos", "public", "dashboard", "index.html")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def get_context(context) -> None:
    """Populate the template with the built app's head/body fragments."""
    _check_access()
    context.no_cache = 1
    context.title = "MAISON · Live"
    context.built = False
    context.dashboard_head = ""
    context.dashboard_body = ""

    html = _built_index()
    if not html:
        return

    head = re.search(r"<head>(.*?)</head>", html, re.S | re.I)
    body = re.search(r"<body>(.*?)</body>", html, re.S | re.I)
    dashboard_head = head.group(1) if head else ""
    # Drop <title> / <meta charset|viewport> that the Frappe page already sets.
    dashboard_head = re.sub(r"<title>.*?</title>", "", dashboard_head, flags=re.S | re.I)
    dashboard_head = re.sub(r'<meta\s+charset=[^>]*>', "", dashboard_head, flags=re.I)
    dashboard_head = re.sub(r'<meta\s+name="viewport"[^>]*>', "", dashboard_head, flags=re.I)

    context.built = True
    context.dashboard_head = dashboard_head.strip()
    context.dashboard_body = (body.group(1) if body else '<div id="app"></div>').strip()
