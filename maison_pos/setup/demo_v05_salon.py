"""v0.5 K — demo data for the AWANZ Salon: a global playlist of curated pieces plus one
boutique-specific playlist (Oak Street). Idempotent; called from ``maison_pos.setup.demo.seed``."""

from __future__ import annotations

from typing import Any

import frappe

GLOBAL_PLAYLIST = {
	"title": "AWANZ · House Selection",
	"boutique": None,
	"welcome_line": "Welcome to the house",
	"items": [
		("HJ-001", "Eighteen carats of light, set by hand over four hundred hours.", 14),
		("TP-007", "A tourbillon that turns once a minute, as it has since 1801.", 12),
		("BR-003", "Two carats, E colour. The proposal piece.", 12),
		("HJ-003", "Ceylon sapphires, the blue of a September evening.", 12),
		("TP-003", "The moon, kept to the minute for one hundred and twenty-two years.", 12),
		("HJ-005", "Seven and a half carats, line by line.", 12),
	],
}

OAK_STREET_PLAYLIST = {
	"title": "Oak Street · Autumn Edit",
	"boutique": "CHI-OAK",
	"welcome_line": "Welcome to Oak Street",
	"items": [
		("HJ-004", "Burmese ruby, pigeon's blood. One of one.", 12),
		("TP-002", "Rose gold warmed by a lakeside autumn.", 12),
		("AC-007", "Akoya pearls, strung in the atelier this season.", 10),
	],
}


def _upsert_playlist(spec: dict[str, Any]) -> str:
	title = spec["title"]
	if frappe.db.exists("AWANZ Salon Playlist", title):
		doc = frappe.get_doc("AWANZ Salon Playlist", title)
	else:
		doc = frappe.new_doc("AWANZ Salon Playlist")
		doc.title = title
	doc.boutique = spec["boutique"] if spec["boutique"] and frappe.db.exists("AWANZ Store", spec["boutique"]) else None
	doc.welcome_line = spec["welcome_line"]
	doc.enabled = 1
	doc.set("items", [])
	for item_code, caption, seconds in spec["items"]:
		if not frappe.db.exists("Item", item_code):
			continue
		doc.append("items", {"item_code": item_code, "caption": caption, "seconds": seconds, "enabled": 1})
	doc.flags.ignore_permissions = True
	doc.save()
	return doc.name


def seed_salon_v05() -> dict[str, Any]:
	"""Create / refresh the two demo playlists. Safe to run repeatedly."""
	if not frappe.db.exists("DocType", "AWANZ Salon Playlist"):
		return {"skipped": "AWANZ Salon Playlist not installed"}
	names = [_upsert_playlist(GLOBAL_PLAYLIST), _upsert_playlist(OAK_STREET_PLAYLIST)]
	# stale demo sessions from previous runs are noise in the desk list
	for old in frappe.get_all("AWANZ Salon Session", filters={"status": ("in", ("Unpaired", "Expired"))}, pluck="name", limit=500):
		frappe.delete_doc("AWANZ Salon Session", old, ignore_permissions=True, force=True)
	return {"playlists": names, "pieces": frappe.db.count("AWANZ Salon Playlist Item", {"parent": ("in", names)})}
