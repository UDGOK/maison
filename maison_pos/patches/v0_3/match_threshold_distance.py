"""v0.3: ``match_threshold`` is now the maximum euclidean distance between RAW descriptors.

Sites that stored the earlier default (0.55, a distance on unit-normalised vectors) are moved to
the face-api rule (0.6 on raw descriptors). Any other explicit value is kept. Idempotent.
"""

from __future__ import annotations

import frappe
from frappe.utils import flt

from maison_pos.biometrics import DEFAULT_DISTANCE_THRESHOLD

OLD_DEFAULT = 0.55


def execute() -> None:
	if not frappe.db.exists("DocType", "AWANZ POS Settings"):
		return
	frappe.reload_doc("awanz_pos", "doctype", "awanz_pos_settings")
	stored = frappe.db.get_single_value("AWANZ POS Settings", "match_threshold")
	if stored in (None, "") or abs(flt(stored) - OLD_DEFAULT) < 1e-6:
		frappe.db.set_single_value("AWANZ POS Settings", "match_threshold", DEFAULT_DISTANCE_THRESHOLD)
	frappe.clear_cache(doctype="AWANZ POS Settings")
	frappe.db.commit()
