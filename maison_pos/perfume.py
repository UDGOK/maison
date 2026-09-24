"""v1.6 — **the perfumery's vocabulary**: what the Concierge asks a client on the client display,
what the till's Client panel shows, and how a client's answers are matched to what is on the
shelf. Pure Python (no ``frappe`` import) so the matching can be tested anywhere.

The mirror of this module for the screens is ``frontend/src/perfume/profile.ts`` — the two lists
must stay identical (``tests/v16_perfume_concierge.test.ts`` pins the TypeScript side, and
``maison_pos/tests/test_v1_6_perfume_concierge.py`` this side, against the same literals).

The families are the way a perfumer talks to a client, not the fine classification on the item
(``Item.maison_fragrance_family`` holds "Floral Fruity", "Woody Spicy", "Oud / Attar" …). Each
family names the words it recognises in that field.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

#: who the fragrance is for, this visit
SHOPPING_FOR = ("Myself", "A gift for him", "A gift for her", "A gift")

#: family → (one line for the card, the words it matches in ``maison_fragrance_family``)
SCENT_FAMILIES: dict[str, tuple[str, tuple[str, ...]]] = {
	"Oud & Woods": ("Agarwood, sandalwood, cedar", ("oud", "attar", "wood", "sandal", "cedar", "vetiver")),
	"Amber & Spice": ("Warm resins, saffron, cardamom", ("oriental", "amber", "spic", "saffron", "resin")),
	"Rose & Florals": ("Taif rose, jasmine, orange blossom", ("floral", "rose", "jasmin", "blossom")),
	"Musk & Powder": ("Soft, clean, close to the skin", ("musk", "powder", "aldehyd", "iris")),
	"Fresh & Citrus": ("Bergamot, lemon, neroli", ("citrus", "fresh", "bergamot", "neroli")),
	"Aquatic & Green": ("Sea air, herbs, cut grass", ("aquatic", "marine", "green", "aromatic", "herb")),
	"Sweet & Gourmand": ("Vanilla, caramel, ripe fruit", ("gourmand", "vanilla", "sweet", "fruity", "caramel")),
	"Leather & Smoke": ("Incense, leather, bakhoor", ("leather", "smok", "incense", "bakhoor", "tobacco")),
}

#: what a client would rather not wear → the words that rule an item out
SCENT_AVOID: dict[str, tuple[str, ...]] = {
	"Too sweet": ("gourmand", "sweet", "vanilla", "caramel"),
	"Heavy oud": ("oud", "attar"),
	"Smoky": ("smok", "incense", "bakhoor", "leather", "tobacco"),
	"Strong florals": ("floral", "rose", "jasmin", "tuberose"),
	"Powdery": ("powder", "aldehyd", "iris"),
	"Too fresh or soapy": ("fresh", "aquatic", "marine", "soap"),
}

#: how the scent should wear (single choice) → one line, and the concentrations it leans to
SCENT_INTENSITY: dict[str, tuple[str, tuple[str, ...]]] = {
	"Close to the skin": ("Only you, and whoever you hug", ("EDT", "Perfume Oil", "Body Mist", "Body Spray", "Cologne")),
	"Noticed nearby": ("Present in a room, never loud", ("EDP", "EDT", "Perfume Oil")),
	"Leaves a trail": ("They know you were here", ("Parfum", "Extrait de Parfum", "EDP")),
}

#: the form it comes in → the concentrations that count
SCENT_FORMS: dict[str, tuple[str, ...]] = {
	"Spray": ("EDP", "EDT", "Parfum", "Extrait de Parfum", "Cologne"),
	"Perfume oil": ("Perfume Oil",),
	"Body mist": ("Body Mist", "Body Spray"),
	"Bakhoor": ("Bakhoor", "Incense"),
}

#: when they wear fragrance
SCENT_MOMENTS = ("Every day", "Work", "Evenings out", "Date night", "Weddings", "Eid & Jumu'ah", "Summer", "Winter")

#: what is coming up (the dated ones feed the birthday coupon and the anniversary follow-up)
SCENT_OCCASIONS = ("Birthday", "Anniversary", "Eid", "Wedding", "Graduation", "Mother's Day", "Father's Day", "Valentine's Day", "Just because")

GENDER_FOR = {"A gift for him": ("Men", "Unisex", ""), "A gift for her": ("Women", "Unisex", "")}


def pick(values: Any, allowed: Iterable[str], limit: int) -> list[str]:
	"""Keep only known values, in the order given, without repeats, at most *limit*."""
	allowed = list(allowed)
	out: list[str] = []
	for v in values if isinstance(values, (list, tuple)) else []:
		if isinstance(v, str) and v in allowed and v not in out:
			out.append(v)
		if len(out) >= limit:
			break
	return out


def split_list(value: Optional[str]) -> list[str]:
	"""A profile Data field holds its list comma-separated (no family name carries a comma)."""
	return [v.strip() for v in (value or "").split(",") if v.strip()]


def _hits(family: str, words: Iterable[str]) -> bool:
	f = (family or "").lower()
	return any(w in f for w in words)


def score_item(item: dict[str, Any], loves: list[str], avoid: list[str], intensity: Optional[str], forms: list[str], shopping_for: Optional[str]) -> Optional[float]:
	"""How well one shelf item fits the answers — ``None`` when it must not be suggested.

	*item* carries ``family`` (``maison_fragrance_family``), ``concentration``, ``gender``,
	``is_gift_set`` and ``on_hand``. Loves are what count; the rest only nudges the order.
	"""
	family = item.get("family") or ""
	conc = item.get("concentration") or ""
	if not family and not loves:
		return None
	if any(_hits(family, SCENT_AVOID.get(a, ())) for a in avoid):
		return None
	allowed_gender = GENDER_FOR.get(shopping_for or "")
	if allowed_gender and (item.get("gender") or "") not in allowed_gender:
		return None
	score = 0.0
	if allowed_gender and item.get("gender") == allowed_gender[0]:
		score += 0.5  # made for him / for her beats unisex, all else equal
	loved = sum(3 for fam in loves if _hits(family, SCENT_FAMILIES.get(fam, ("", ()))[1]))
	if loves and not loved:
		return None
	score += loved
	if intensity and conc in SCENT_INTENSITY.get(intensity, ("", ()))[1]:
		score += 1
	if forms and any(conc in SCENT_FORMS.get(f, ()) for f in forms):
		score += 1.5
	gift = (shopping_for or "Myself") != "Myself"
	if item.get("is_gift_set"):
		score += 1 if gift else -1
	return score


def suggest(items: list[dict[str, Any]], answers: dict[str, Any], limit: int = 3) -> list[dict[str, Any]]:
	"""The best *limit* items on the shelf for these answers, best first (stock breaks ties)."""
	loves = answers.get("scent_families") or []
	if not loves:
		return []
	ranked = []
	for it in items:
		s = score_item(it, loves, answers.get("scent_avoid") or [], answers.get("scent_intensity"), answers.get("scent_forms") or [], answers.get("shopping_for"))
		if s is not None and s > 0:
			# depth past a few units says nothing about fit — cap it so a 5,000-vial oil does not
			# win every tie
			ranked.append((s, min(float(it.get("on_hand") or 0), 6.0), it.get("item_name") or "", it))
	ranked.sort(key=lambda r: (-r[0], -r[1], r[2]))
	return [r[3] for r in ranked[:limit]]


def summary(answers: dict[str, Any]) -> str:
	"""One line the associate reads on the till: who for, what they love, what to avoid, how."""
	bits: list[str] = []
	who = answers.get("shopping_for")
	if who and who != "Myself":
		bits.append(who)
	if answers.get("scent_families"):
		bits.append("Loves " + ", ".join(answers["scent_families"]))
	if answers.get("scent_avoid"):
		bits.append("Avoids " + ", ".join(answers["scent_avoid"]).lower())
	how = [answers.get("scent_intensity") or ""] + list(answers.get("scent_forms") or [])
	how = [h for h in how if h]
	if how:
		bits.append(" · ".join(how))
	if answers.get("scent_moments"):
		bits.append("For " + ", ".join(answers["scent_moments"]))
	if answers.get("signature_scent"):
		bits.append("Wears " + answers["signature_scent"])
	if answers.get("occasions"):
		bits.append("Coming up: " + ", ".join(answers["occasions"]))
	return " · ".join(bits)
