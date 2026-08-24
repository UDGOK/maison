"""AWANZ Face Template — child row on Customer (``maison_face_templates``).

Holds one face embedding (JSON float array, never an image) captured with the client's
consent. Rows are created only through ``maison_pos.api.recognition.enroll`` and removed by
``revoke`` / the daily retention purge. The process-level match cache is invalidated by the
Customer ``on_update`` hook whenever this table changes.
"""

from __future__ import annotations

from frappe.model.document import Document


class AWANZFaceTemplate(Document):
	pass
