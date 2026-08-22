"""Maison POS Settings (single): global POS switches merged into ``catalog.bootstrap``."""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, get_url

from maison_pos.biometrics import (
	CONSENT_TEXT_VERSION,
	DEFAULT_CONSENT_TEXT_EN,
	DEFAULT_DISTANCE_THRESHOLD,
	DEFAULT_MODEL,
	DEFAULT_RETENTION_MONTHS,
	MAX_DISTANCE_THRESHOLD,
)

SETTINGS_KEYS = (
	"show_product_images_default",
	"scan_enabled",
	"receipt_qr_enabled",
	"receipt_qr_base_url",
	"loyalty_lookup_enabled",
	"face_recognition_enabled",
	"recognition_model",
	"match_threshold",
	"biometric_retention_months",
	"recognition_offline_cache",
	"consent_text",
	"consent_text_version",
	# --- v0.4 returns / inventory (maison_pos.api.returns, maison_pos.api.inventory) ---
	"return_window_days",
	"exchange_window_days",
	"returns_manager_threshold",
	"low_stock_digest_enabled",
	"low_stock_notify_regional",
)

# v0.4 defaults (returns & exchanges, inventory alerts)
OPERATIONS_DEFAULTS: dict[str, Any] = {
	"return_window_days": 30,
	"exchange_window_days": 60,
	"returns_manager_threshold": 2500.0,
	"low_stock_digest_enabled": 1,
	"low_stock_notify_regional": 0,
}

# v0.2 switches that default to on; persisted by ``ensure_recognition_defaults`` so that a
# Single saved from the desk does not silently flip them to 0 (Frappe does not apply field
# defaults to a Single row that already exists).
BASE_DEFAULTS: dict[str, Any] = {
	"scan_enabled": 1,
	"receipt_qr_enabled": 1,
	"loyalty_lookup_enabled": 1,
}

RECOGNITION_DEFAULTS: dict[str, Any] = {
	"face_recognition_enabled": 0,
	"recognition_model": DEFAULT_MODEL,
	"match_threshold": DEFAULT_DISTANCE_THRESHOLD,
	"biometric_retention_months": DEFAULT_RETENTION_MONTHS,
	"recognition_offline_cache": 1,
	"consent_text": DEFAULT_CONSENT_TEXT_EN,
	"consent_text_version": CONSENT_TEXT_VERSION,
}


class MaisonPOSSettings(Document):
	def validate(self) -> None:
		self.receipt_qr_base_url = (self.receipt_qr_base_url or "").strip().rstrip("/")
		self.recognition_model = (self.recognition_model or "").strip() or DEFAULT_MODEL
		if flt(self.match_threshold) <= 0 or flt(self.match_threshold) > MAX_DISTANCE_THRESHOLD:
			frappe.throw(
				_("Match threshold must be a euclidean distance between 0 and {0} (default {1})").format(MAX_DISTANCE_THRESHOLD, DEFAULT_DISTANCE_THRESHOLD),
				frappe.ValidationError,
			)
		if cint(self.biometric_retention_months) <= 0:
			frappe.throw(_("Biometric retention must be at least 1 month"), frappe.ValidationError)
		self.consent_text_version = (self.consent_text_version or "").strip() or CONSENT_TEXT_VERSION
		if not (self.consent_text or "").strip():
			self.consent_text = DEFAULT_CONSENT_TEXT_EN


def ensure_recognition_defaults() -> None:
	"""Fill the v0.3 settings fields on sites that already had the Single (defaults only apply to new rows)."""
	if not frappe.db.exists("DocType", "Maison POS Settings"):
		return
	stored = frappe.db.get_singles_dict("Maison POS Settings")
	for key, value in {**BASE_DEFAULTS, **RECOGNITION_DEFAULTS, **OPERATIONS_DEFAULTS}.items():
		if key == "face_recognition_enabled":
			continue  # off unless Head Office switched it on
		if stored.get(key) in (None, ""):
			frappe.db.set_single_value("Maison POS Settings", key, value)
	frappe.clear_cache(doctype="Maison POS Settings")


def get_receipt_qr_base_url() -> str:
	"""Base URL for receipt QR links (settings value, else the site URL)."""
	return get_pos_settings()["receipt_qr_base_url"]


def _raw_settings() -> dict[str, Any]:
	defaults: dict[str, Any] = {
		"show_product_images_default": 0,
		"scan_enabled": 1,
		"receipt_qr_enabled": 1,
		"receipt_qr_base_url": "",
		"loyalty_lookup_enabled": 1,
	}
	defaults.update(RECOGNITION_DEFAULTS)
	defaults.update(OPERATIONS_DEFAULTS)
	if frappe.db.exists("DocType", "Maison POS Settings"):
		# Read the stored row, not the Document: a Single that was saved before a field
		# existed has no value for it, and the Document would report 0 instead of the default.
		stored = frappe.db.get_singles_dict("Maison POS Settings", cast=True)
		for key in SETTINGS_KEYS:
			value = stored.get(key)
			if value not in (None, ""):
				defaults[key] = value
	return defaults


def is_recognition_enabled(boutique: Optional[str] = None) -> bool:
	"""Effective camera-recognition switch: boutique override (On/Off) else the global setting."""
	raw = _raw_settings()
	enabled = cint(raw["face_recognition_enabled"])
	if boutique:
		override = frappe.db.get_value("Maison Boutique", boutique, "face_recognition_enabled")
		if override == "On":
			enabled = 1
		elif override == "Off":
			enabled = 0
	return bool(enabled)


def get_recognition_settings(boutique: Optional[str] = None) -> dict[str, Any]:
	"""Recognition block used by ``recognition.*`` and merged into ``bootstrap.settings``."""
	raw = _raw_settings()
	distance = flt(raw["match_threshold"])
	if distance <= 0 or distance > MAX_DISTANCE_THRESHOLD:
		distance = DEFAULT_DISTANCE_THRESHOLD
	return {
		"face_recognition_enabled": 1 if is_recognition_enabled(boutique) else 0,
		"face_recognition_global": cint(raw["face_recognition_enabled"]),
		"recognition_model": raw["recognition_model"] or DEFAULT_MODEL,
		# ONE definition: maximum euclidean distance between RAW embeddings (face-api: 0.6).
		"match_threshold": distance,
		"match_distance_threshold": distance,
		"biometric_retention_months": cint(raw["biometric_retention_months"]) or DEFAULT_RETENTION_MONTHS,
		"recognition_offline_cache": cint(raw["recognition_offline_cache"]),
		"consent_text": raw["consent_text"] or DEFAULT_CONSENT_TEXT_EN,
		"consent_text_version": raw["consent_text_version"] or CONSENT_TEXT_VERSION,
	}


def get_pos_settings(boutique: Optional[str] = None) -> dict[str, Any]:
	"""Effective settings for the POS: global values with the boutique's overrides applied.

	Returned by ``catalog.bootstrap`` / ``delta`` as ``settings``.
	"""
	defaults = _raw_settings()

	show_images = cint(defaults["show_product_images_default"])
	if boutique:
		override = frappe.db.get_value("Maison Boutique", boutique, "show_product_images")
		if cint(override):
			show_images = 1

	out = {
		"show_product_images": show_images,
		"show_product_images_default": cint(defaults["show_product_images_default"]),
		"scan_enabled": cint(defaults["scan_enabled"]),
		"receipt_qr_enabled": cint(defaults["receipt_qr_enabled"]),
		"receipt_qr_base_url": (defaults["receipt_qr_base_url"] or get_url()).rstrip("/"),
		"loyalty_lookup_enabled": cint(defaults["loyalty_lookup_enabled"]),
	}
	out.update(get_recognition_settings(boutique))
	out.update(get_operations_settings())
	return out


def get_operations_settings() -> dict[str, Any]:
	"""v0.4 returns / inventory block (merged into ``bootstrap.settings``)."""
	raw = _raw_settings()
	return {
		"return_window_days": cint(raw["return_window_days"]) or OPERATIONS_DEFAULTS["return_window_days"],
		"exchange_window_days": cint(raw["exchange_window_days"]) or OPERATIONS_DEFAULTS["exchange_window_days"],
		"returns_manager_threshold": flt(raw["returns_manager_threshold"]),
		"low_stock_digest_enabled": cint(raw["low_stock_digest_enabled"]),
		"low_stock_notify_regional": cint(raw["low_stock_notify_regional"]),
	}
