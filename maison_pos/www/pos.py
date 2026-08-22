"""Serve the built Maison POS PWA shell at ``/pos``.

The Vite build (``frontend/``) writes hashed assets into ``maison_pos/public/pos/``
(served by Frappe/nginx at ``/assets/maison_pos/pos/``). Because the file names are
hashed we cannot reference them statically, so ``get_context`` reads the built
``index.html`` once per request, extracts its ``<head>`` tags (modulepreload links,
stylesheets, manifest, fonts) and the ``<script type="module">`` tag, and hands them to
``pos.html`` which also injects the session CSRF token as ``window.csrf_token`` for the
API client (``frontend/src/api/frappe.ts``).

Notes
-----
* The page is login-only: anonymous visitors are redirected to ``/login?redirect-to=/pos``.
* PWA scope is ``/pos/`` while the built ``sw.js`` lives under ``/assets/...``. The app registers
  the worker via ``/api/method/maison_pos.api.pwa.service_worker`` (``maison_pos/api/pwa.py``),
  which serves the built file with ``Service-Worker-Allowed: /pos/`` so no nginx configuration
  is required (works on Frappe Cloud). The ``docker/`` nginx header for
  ``/assets/maison_pos/pos/sw.js`` is kept but no longer needed.
"""

from __future__ import annotations

import os
import re

import frappe
from frappe import _

no_cache = 1

_HEAD_TAG_RE = re.compile(r"<(link|script)\b[^>]*?(?:/>|>.*?</\1>|>)", re.S | re.I)


def _built_index_path() -> str:
    app_path = frappe.get_app_path("maison_pos")
    return os.path.join(app_path, "public", "pos", "index.html")


def _extract_assets(html: str) -> tuple[str, str]:
    """Return (head_tags, body_tags) from the built index.html.

    Only ``<link>`` and ``<script>`` tags are kept; everything else in the Vite shell is
    reproduced by ``pos.html`` itself.
    """
    head_m = re.search(r"<head>(.*?)</head>", html, re.S | re.I)
    body_m = re.search(r"<body>(.*?)</body>", html, re.S | re.I)
    head = "\n".join(m.group(0) for m in _HEAD_TAG_RE.finditer(head_m.group(1) if head_m else ""))
    body = "\n".join(m.group(0) for m in _HEAD_TAG_RE.finditer(body_m.group(1) if body_m else ""))
    return head, body


def get_context(context: dict) -> dict:
    """Jinja context for ``www/pos.html``."""
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/pos"
        raise frappe.Redirect

    context.no_cache = 1
    context.no_breadcrumbs = 1
    context.title = "Maison POS"
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.site_user = frappe.session.user

    index_path = _built_index_path()
    if not os.path.exists(index_path):
        context.built = False
        context.head_tags = ""
        context.body_tags = ""
        context.build_hint = _(
            "PWA not built. Run `cd frontend && npm i && npm run build` then `bench build --app maison_pos`."
        )
        return context

    with open(index_path, encoding="utf-8") as f:
        head, body = _extract_assets(f.read())
    context.built = True
    context.head_tags = head
    context.body_tags = body
    return context
