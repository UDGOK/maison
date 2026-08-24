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
		body = "// AWANZ POS service worker not built (cd frontend && npm run build)\n"
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


# --- v0.7 white-label — the installed-app identity comes from the brand, not the build ---
@frappe.whitelist(allow_guest=True, methods=["GET"])
def manifest() -> Response:
	"""``manifest.webmanifest`` built from ``AWANZ POS Settings``.

	The Vite build writes a static manifest with the app's own name in it, which would install
	on a customer's home screen under the wrong brand. This endpoint serves the same manifest
	with ``name`` / ``short_name`` / ``description`` (and the icons, when the tenant has
	uploaded a logo) taken from the brand at request time, so one build serves every tenant.
	"""
	import json

	from maison_pos.brand import get_brand

	brand = get_brand()
	product = str(brand.get("product_name") or brand.get("brand_name") or "AWANZ POS")
	short = str(brand.get("brand_name") or product)
	tagline = str(brand.get("tagline") or "")
	store_noun = str(brand.get("store_noun") or "Store").lower()

	data = {
		"name": product,
		"short_name": short,
		"description": tagline or f"{short} {store_noun} point of sale",
		"start_url": "/pos/",
		"display": "standalone",
		"background_color": "#0B0B0A",
		"theme_color": "#0B0B0A",
		"lang": "en",
		"scope": "/pos/",
		"orientation": "any",
		"icons": _manifest_icons(brand),
	}
	body = json.dumps(data, separators=(",", ":"))
	resp = Response(body, status=200, content_type="application/manifest+json; charset=utf-8")
	resp.headers["Cache-Control"] = "no-cache"
	return resp


def _manifest_icons(brand: dict) -> list[dict]:
	base = "/assets/maison_pos/pos/icons"
	icons: list[dict] = []
	logo = brand.get("brand_logo")
	if logo and str(logo).lower().endswith(".png"):
		# a tenant-supplied PNG can serve every size the installer asks for
		icons.append({"src": logo, "sizes": "512x512", "type": "image/png"})
		icons.append({"src": logo, "sizes": "512x512", "type": "image/png", "purpose": "maskable"})
	elif logo and str(logo).lower().endswith(".svg"):
		icons.append({"src": logo, "sizes": "any", "type": "image/svg+xml"})
	icons += [
		{"src": f"{base}/icon-192.png", "sizes": "192x192", "type": "image/png"},
		{"src": f"{base}/icon-512.png", "sizes": "512x512", "type": "image/png"},
		{"src": f"{base}/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
		{"src": f"{base}/apple-touch-icon.png", "sizes": "180x180", "type": "image/png"},
	]
	return icons
