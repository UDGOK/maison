"""PWA helpers: serve the built service worker from a URL that may control ``/pos/``.

The Vite build writes ``sw.js`` into ``maison_pos/public/pos/`` which Frappe serves at
``/assets/maison_pos/pos/sw.js``. A service worker may only control paths at or below its
own URL unless the script response carries a ``Service-Worker-Allowed`` header — and on
managed hosting (Frappe Cloud) the platform's nginx serves ``/assets`` without it, so
registering the worker with scope ``/pos/`` is rejected by the browser.

This endpoint reads the built file and returns it with the header set, so the PWA can
register ``/api/method/maison_pos.api.pwa.service_worker`` with scope ``/pos/`` on any
deployment (no custom nginx required). The worker itself is built with absolute
``/assets/maison_pos/pos/`` URLs (``inlineWorkboxRuntime`` + ``modifyURLPrefix`` in
``frontend/vite.config.ts``) so it does not care where it is served from.
"""

from __future__ import annotations

import hashlib
import os

import frappe
from werkzeug.wrappers import Response

SW_SCOPE = "/pos/"


def _built_sw_path() -> str:
	return os.path.join(frappe.get_app_path("maison_pos"), "public", "pos", "sw.js")


@frappe.whitelist(allow_guest=True, methods=["GET"])
def service_worker() -> Response:
	"""Return the built ``sw.js`` with ``Service-Worker-Allowed: /pos/``."""
	path = _built_sw_path()
	if not os.path.exists(path):
		body = "// Maison POS service worker not built (cd frontend && npm run build)\n"
		resp = Response(body, status=404, content_type="application/javascript; charset=utf-8")
		resp.headers["Cache-Control"] = "no-cache"
		return resp

	with open(path, "rb") as f:
		body = f.read()

	etag = '"%s"' % hashlib.sha1(body).hexdigest()[:16]
	if frappe.local.request and frappe.local.request.headers.get("If-None-Match") == etag:
		resp = Response(status=304)
	else:
		resp = Response(body, status=200, content_type="application/javascript; charset=utf-8")
	resp.headers["ETag"] = etag
	resp.headers["Service-Worker-Allowed"] = SW_SCOPE
	# Browsers bypass the HTTP cache for worker scripts after 24h anyway; make updates immediate.
	resp.headers["Cache-Control"] = "no-cache"
	resp.headers["X-Content-Type-Options"] = "nosniff"
	return resp
