"""Child table of Maison Boutique: the Stripe Terminal readers paired to the store."""

from frappe.model.document import Document

# device_type -> (display name, has built-in printer)
READER_TYPES = {
	"verifone_v660p": ("Verifone V660p", True),
	"stripe_s710": ("Stripe Reader S710", False),
	"bbpos_wisepos_e": ("BBPOS WisePOS E", False),
	"simulated": ("Simulated reader", True),
}


class MaisonBoutiqueReader(Document):
	pass
