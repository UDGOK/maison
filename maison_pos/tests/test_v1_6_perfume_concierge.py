"""v1.6 — the perfumery's Concierge: the vocabulary and the shelf matching (`maison_pos/perfume.py`).

Pure functions — no site needed. The literals below are the same ones
`frontend/src/tests/v16_perfume_concierge.test.ts` pins on the TypeScript mirror.
"""

import unittest

from maison_pos import perfume as P

SHELF = [
	{"item_code": "ARB-001", "item_name": "Nyla", "family": "Floral Fruity", "concentration": "EDP", "gender": "Women", "is_gift_set": False, "on_hand": 2},
	{"item_code": "ARB-002", "item_name": "His Confession", "family": "Woody Spicy", "concentration": "EDP", "gender": "Men", "is_gift_set": False, "on_hand": 2},
	{"item_code": "ARB-007", "item_name": "Casablanca", "family": "Oriental Woody", "concentration": "Extrait de Parfum", "gender": "Unisex", "is_gift_set": False, "on_hand": 3},
	{"item_code": "OIL-001", "item_name": "Assorted oil", "family": "Oud / Attar", "concentration": "Perfume Oil", "gender": "Unisex", "is_gift_set": False, "on_hand": 5616},
	{"item_code": "GFT-001", "item_name": "Aqua set", "family": "Aquatic Fresh", "concentration": "Gift Set", "gender": "Men", "is_gift_set": True, "on_hand": 2},
	{"item_code": "SWT-001", "item_name": "Sherbet", "family": "Fruity Gourmand", "concentration": "EDP", "gender": "Women", "is_gift_set": False, "on_hand": 9},
	{"item_code": "BLANK", "item_name": "No family", "family": "", "concentration": "EDP", "gender": "", "is_gift_set": False, "on_hand": 9},
]


class TestPerfumeVocabulary(unittest.TestCase):
	def test_the_lists_the_screens_mirror(self):
		self.assertEqual(P.SHOPPING_FOR, ("Myself", "A gift for him", "A gift for her", "A gift"))
		self.assertEqual(list(P.SCENT_FAMILIES), ["Oud & Woods", "Amber & Spice", "Rose & Florals", "Musk & Powder", "Fresh & Citrus", "Aquatic & Green", "Sweet & Gourmand", "Leather & Smoke"])
		self.assertEqual(list(P.SCENT_AVOID), ["Too sweet", "Heavy oud", "Smoky", "Strong florals", "Powdery", "Too fresh or soapy"])
		self.assertEqual(list(P.SCENT_INTENSITY), ["Close to the skin", "Noticed nearby", "Leaves a trail"])
		self.assertEqual(list(P.SCENT_FORMS), ["Spray", "Perfume oil", "Body mist", "Bakhoor"])
		self.assertEqual(P.SCENT_MOMENTS, ("Every day", "Work", "Evenings out", "Date night", "Weddings", "Eid & Jumu'ah", "Summer", "Winter"))
		for name in list(P.SCENT_FAMILIES) + list(P.SCENT_AVOID) + list(P.SCENT_FORMS) + list(P.SCENT_MOMENTS):
			self.assertNotIn(",", name, "profile lists are stored comma-separated")

	def test_pick_keeps_known_words_in_order_once(self):
		self.assertEqual(P.pick(["Oud & Woods", "made up", "Oud & Woods", "Rose & Florals", "Musk & Powder", "Amber & Spice"], P.SCENT_FAMILIES, 3), ["Oud & Woods", "Rose & Florals", "Musk & Powder"])
		self.assertEqual(P.pick("Oud & Woods", P.SCENT_FAMILIES, 3), [])
		self.assertEqual(P.split_list(" Oud & Woods, Rose & Florals ,, "), ["Oud & Woods", "Rose & Florals"])


class TestShelfMatching(unittest.TestCase):
	def codes(self, answers):
		return [x["item_code"] for x in P.suggest(SHELF, answers)]

	def test_loves_decide_and_avoid_rules_out(self):
		out = self.codes({"shopping_for": "Myself", "scent_families": ["Oud & Woods", "Amber & Spice"], "scent_avoid": ["Too sweet"], "scent_intensity": "Leaves a trail", "scent_forms": ["Spray"]})
		self.assertEqual(out[0], "ARB-007")  # woody + oriental + extrait + a spray
		self.assertNotIn("SWT-001", out)
		self.assertNotIn("BLANK", out)

	def test_a_gift_for_him_never_suggests_a_womens_scent_and_prefers_made_for_him(self):
		out = self.codes({"shopping_for": "A gift for him", "scent_families": ["Oud & Woods", "Rose & Florals"]})
		self.assertNotIn("ARB-001", out)
		self.assertEqual(out[0], "ARB-002")
		# the made-for-him bonus never turns a scent he did not ask for into a suggestion
		self.assertEqual(self.codes({"shopping_for": "A gift for him", "scent_families": ["Rose & Florals"]}), [])

	def test_oil_lovers_get_the_oil_unless_they_avoid_oud(self):
		self.assertEqual(self.codes({"scent_families": ["Oud & Woods"], "scent_forms": ["Perfume oil"]})[0], "OIL-001")
		self.assertNotIn("OIL-001", self.codes({"scent_families": ["Oud & Woods"], "scent_avoid": ["Heavy oud"], "scent_forms": ["Perfume oil"]}))

	def test_nothing_loved_nothing_suggested(self):
		self.assertEqual(P.suggest(SHELF, {"scent_avoid": ["Smoky"]}), [])

	def test_summary_reads_like_a_note(self):
		line = P.summary({"shopping_for": "A gift for her", "scent_families": ["Rose & Florals"], "scent_avoid": ["Too sweet"], "scent_intensity": "Noticed nearby", "scent_forms": ["Perfume oil"], "scent_moments": ["Eid & Jumu'ah"], "signature_scent": "Delina", "occasions": ["Anniversary"]})
		self.assertEqual(line, "A gift for her · Loves Rose & Florals · Avoids too sweet · Noticed nearby · Perfume oil · For Eid & Jumu'ah · Wears Delina · Coming up: Anniversary")
		self.assertEqual(P.summary({"shopping_for": "Myself"}), "")


if __name__ == "__main__":
	unittest.main()
