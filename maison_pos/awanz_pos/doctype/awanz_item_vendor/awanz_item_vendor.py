"""AWANZ Item Vendor (v1.0 §B) — one vendor's terms for one item, on ``Item.maison_vendors``.

The rules (exactly one preferred vendor, ``cost`` writing through to the vendor's Item Price)
live in ``maison_pos.purchasing.vendors`` because they need the parent Item.
"""

from frappe.model.document import Document


class AWANZItemVendor(Document):
	pass
