"""Maison POS Settings (single): global POS switches merged into ``catalog.bootstrap``."""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.model.document import Document
from frappe.utils import cint, get_url

SETTINGS_KEYS = (
	"show_product_images_default",
	"scan_enabled",
	"receipt_qr_enabled",
	"receipt_qr_base_url",
	"loyalty_lookup_enabled",
	"face_recognition_enabled",
)


class MaisonPOSSettings(Document):
	def validate(self) -> None:
		self.receipt_qr_base_url = (self.receipt_qr_base_url or "").strip().rstrip("/")
		# scaffold only — recognition cannot be switched on (see SPEC_v0.2 §7)
		self.face_recognition_enabled = 0


def get_receipt_qr_base_url() -> str:
	"""Base URL for receipt QR links (settings value, else the site URL)."""
	return get_pos_settings()["receipt_qr_base_url"]


def get_pos_settings(boutique: Optional[str] = None) -> dict[str, Any]:
	"""Effective settings for the POS: global values with the boutique's overrides applied.

	Returned by ``catalog.bootstrap`` / ``delta`` as ``settings``.
	"""
	defaults = {
		"show_product_images_default": 0,
		"scan_enabled": 1,
		"receipt_qr_enabled": 1,
		"receipt_qr_base_url": "",
		"loyalty_lookup_enabled": 1,
		"face_recognition_enabled": 0,
	}
	if frappe.db.exists("DocType", "Maison POS Settings"):
		doc = frappe.get_cached_doc("Maison POS Settings")
		for key in SETTINGS_KEYS:
			value = doc.get(key)
			if value is not None:
				defaults[key] = value

	show_images = cint(defaults["show_product_images_default"])
	if boutique:
		override = frappe.db.get_value("Maison Boutique", boutique, "show_product_images")
		if cint(override):
			show_images = 1

	return {
		"show_product_images": show_images,
		"show_product_images_default": cint(defaults["show_product_images_default"]),
		"scan_enabled": cint(defaults["scan_enabled"]),
		"receipt_qr_enabled": cint(defaults["receipt_qr_enabled"]),
		"receipt_qr_base_url": (defaults["receipt_qr_base_url"] or get_url()).rstrip("/"),
		"loyalty_lookup_enabled": cint(defaults["loyalty_lookup_enabled"]),
		"face_recognition_enabled": 0,
	}
