"""v0.8 QA C2 — CloudChaserz Salon playlists.

The client-facing screen (`/salon`) fills the gap between sales with a `Maison Salon Playlist`:
without one it shows nothing but the wordmark and the clock. The jewellery seed has always
created two (`setup/demo_v05_salon.py`); the CloudChaserz seed had no Salon step at all, so the
ambient screen was bare on the smoke-shop tenant.

One chain-wide playlist plus one store playlist (Broken Arrow), captioned in the tenant's own
voice. Idempotent — items that are not in the catalogue are skipped, so a partial catalogue
still produces a usable playlist.
"""

from __future__ import annotations

from typing import Any

import frappe

GLOBAL_PLAYLIST: dict[str, Any] = {
	"title": "CloudChaserz · House Picks",
	"boutique": None,
	"welcome_line": "Welcome to CloudChaserz",
	"items": [
		("DSP-001", "Geek Bar Pulse 15K — dual mode, 15,000 puffs. 21+, ID at the counter.", 12),
		("DEV-008", "Aegis Legend 3 — the kit that survives a job site.", 12),
		("GLS-003", "18\" double perc beaker, blue accents. Bring it back for a free clean.", 12),
		("HKA-002", "Starbuzz Carbine 2.0 — ask us to set up the bowl and coals.", 12),
		("CBD-003", "Full spectrum CBD, 1000mg. Lab results on every batch.", 12),
		("KRT-001", "Green Maeng Da, 100g. Lab-tested, 21+.", 12),
	],
}

STORE_PLAYLIST: dict[str, Any] = {
	"title": "Broken Arrow · This Week",
	"boutique": "OK-BA",
	"welcome_line": "Welcome to Broken Arrow",
	"items": [
		("DSP-008", "Lost Mary MO20000 Pro — Blue Razz Ice. New this week.", 12),
		("DEV-003", "SMOK Arcfox 230W — dual battery, full control.", 12),
		("ACC-007", "Aluminum 4-piece grinder, 2.5\". Lifetime workhorse.", 10),
	],
}


def seed_salon() -> dict[str, Any]:
	"""Create / refresh the CloudChaserz playlists. Safe to run repeatedly."""
	if not frappe.db.exists("DocType", "Maison Salon Playlist"):
		return {"skipped": "Maison Salon Playlist not installed"}
	from maison_pos.setup.demo_v05_salon import _upsert_playlist

	names = [_upsert_playlist(GLOBAL_PLAYLIST)]
	if frappe.db.exists("Maison Boutique", STORE_PLAYLIST["boutique"]):
		names.append(_upsert_playlist(STORE_PLAYLIST))
	return {"playlists": names, "pieces": frappe.db.count("Maison Salon Playlist Item", {"parent": ("in", names)})}
