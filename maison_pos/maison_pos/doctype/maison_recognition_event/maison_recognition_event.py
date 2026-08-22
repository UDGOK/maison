"""Maison Recognition Event — audit trail for every recognition outcome.

Written by ``maison_pos.api.recognition`` (Matched / NoMatch / Enrolled / Undone / Declined /
Revoked) and by the retention purge (Purged). Feeds the dashboard ``recognition`` counts.
"""

from __future__ import annotations

from frappe.model.document import Document


class MaisonRecognitionEvent(Document):
	pass
