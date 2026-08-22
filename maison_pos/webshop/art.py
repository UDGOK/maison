"""Deterministic SVG product visuals for the demo catalogue (no photography in the seed).

Each piece gets a 1200×1200 onyx square with a line drawing in the metal's tone: watches,
rings, necklaces, earrings, bracelets, pearls… The goal is a coherent, premium-looking
storefront out of the box; real product photography simply replaces ``Item.image``.
"""

from __future__ import annotations

import hashlib
import math

GROUND = "#0B0B0A"
SURFACE = "#141311"
GOLD = "#C9A96E"

METAL_TONES = {
	"Steel": "#C8CCD0",
	"Titanium": "#9EA4AB",
	"Platinum": "#E3E1DB",
	"18k White Gold": "#E3E1DB",
	"18k Yellow Gold": "#C9A96E",
	"18k Rose Gold": "#D9A98A",
	"Sterling Silver": "#C8CCD0",
}


def _tone(metal: str | None) -> str:
	return METAL_TONES.get(metal or "", GOLD)


def _seed(code: str) -> float:
	return int(hashlib.sha1(code.encode()).hexdigest()[:6], 16) / 0xFFFFFF


def _stone(cx: float, cy: float, r: float, color: str = "#EFE8DA") -> str:
	"""Brilliant-cut stone: an octagon with a faint inner star."""
	pts = []
	for i in range(8):
		a = math.pi / 8 + i * math.pi / 4
		pts.append(f"{cx + r * math.cos(a):.1f},{cy + r * math.sin(a):.1f}")
	inner = []
	for i in range(8):
		a = i * math.pi / 4
		inner.append(f"{cx + r * 0.55 * math.cos(a):.1f},{cy + r * 0.55 * math.sin(a):.1f}")
	return (
		f'<polygon points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="2"/>'
		f'<polygon points="{" ".join(inner)}" fill="none" stroke="{color}" stroke-width="1" opacity=".6"/>'
		f'<line x1="{cx - r:.1f}" y1="{cy:.1f}" x2="{cx + r:.1f}" y2="{cy:.1f}" stroke="{color}" stroke-width="1" opacity=".35"/>'
	)


def _watch(tone: str, s: float, diamonds: bool) -> str:
	cx = cy = 600
	r = 300 + 40 * s
	ticks = "".join(
		f'<line x1="{cx + (r - 34) * math.cos(a):.1f}" y1="{cy + (r - 34) * math.sin(a):.1f}" '
		f'x2="{cx + (r - 12 - (18 if i % 3 == 0 else 0)) * math.cos(a):.1f}" y2="{cy + (r - 12 - (18 if i % 3 == 0 else 0)) * math.sin(a):.1f}" '
		f'stroke="{tone}" stroke-width="{3 if i % 3 == 0 else 1.5}"/>'
		for i, a in ((i, -math.pi / 2 + i * math.pi / 6) for i in range(12))
	)
	bezel = ""
	if diamonds:
		bezel = "".join(
			f'<circle cx="{cx + (r + 14) * math.cos(a):.1f}" cy="{cy + (r + 14) * math.sin(a):.1f}" r="5" fill="#EFE8DA" opacity=".9"/>'
			for a in (i * math.pi / 24 for i in range(48))
		)
	lugs = (
		f'<path d="M{cx - 120} {cy - r + 20} L{cx - 150} {cy - r - 120} L{cx + 150} {cy - r - 120} L{cx + 120} {cy - r + 20}" fill="none" stroke="{tone}" stroke-width="3"/>'
		f'<path d="M{cx - 120} {cy + r - 20} L{cx - 150} {cy + r + 120} L{cx + 150} {cy + r + 120} L{cx + 120} {cy + r - 20}" fill="none" stroke="{tone}" stroke-width="3"/>'
		f'<rect x="{cx - 150}" y="{cy - r - 124}" width="300" height="4" fill="{tone}" opacity=".5"/>'
		f'<rect x="{cx - 150}" y="{cy + r + 120}" width="300" height="4" fill="{tone}" opacity=".5"/>'
	)
	moon = f'<circle cx="{cx}" cy="{cy + 120}" r="46" fill="none" stroke="{tone}" stroke-width="1.5" opacity=".8"/><circle cx="{cx + 16}" cy="{cy + 110}" r="14" fill="{tone}" opacity=".6"/>' if s > 0.5 else ""
	return (
		f'<circle cx="{cx}" cy="{cy}" r="{r + 28:.0f}" fill="none" stroke="{tone}" stroke-width="6"/>'
		f'<circle cx="{cx}" cy="{cy}" r="{r:.0f}" fill="{SURFACE}" stroke="{tone}" stroke-width="2"/>'
		f"{bezel}{ticks}{moon}{lugs}"
		f'<line x1="{cx}" y1="{cy}" x2="{cx + (r - 150) * math.cos(-math.pi / 3):.1f}" y2="{cy + (r - 150) * math.sin(-math.pi / 3):.1f}" stroke="{tone}" stroke-width="6" stroke-linecap="round"/>'
		f'<line x1="{cx}" y1="{cy}" x2="{cx + (r - 70) * math.cos(math.pi / 9):.1f}" y2="{cy + (r - 70) * math.sin(math.pi / 9):.1f}" stroke="{tone}" stroke-width="4" stroke-linecap="round"/>'
		f'<circle cx="{cx}" cy="{cy}" r="9" fill="{tone}"/>'
		f'<rect x="{cx + r + 24}" y="{cy - 22}" width="26" height="44" rx="4" fill="{tone}"/>'
	)


def _ring(tone: str, s: float, carat: float, halo: bool = False, three: bool = False) -> str:
	cx, cy = 600, 660
	rx, ry = 250, 250
	stone_r = 40 + min(carat, 3) * 22
	out = (
		f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" stroke="{tone}" stroke-width="{18 + 8 * s:.0f}"/>'
		f'<ellipse cx="{cx}" cy="{cy}" rx="{rx - 14}" ry="{ry - 14}" fill="none" stroke="{GROUND}" stroke-width="3" opacity=".6"/>'
	)
	top = cy - ry
	if three:
		out += _stone(cx, top - 10, stone_r) + _stone(cx - stone_r * 1.7, top + 10, stone_r * 0.6) + _stone(cx + stone_r * 1.7, top + 10, stone_r * 0.6)
	else:
		out += _stone(cx, top - 10, stone_r)
		if halo:
			out += "".join(
				f'<circle cx="{cx + (stone_r + 18) * math.cos(a):.1f}" cy="{top - 10 + (stone_r + 18) * math.sin(a):.1f}" r="6" fill="#EFE8DA" opacity=".85"/>'
				for a in (i * math.pi / 9 for i in range(18))
			)
	# prongs
	for a in (math.pi / 4, 3 * math.pi / 4, 5 * math.pi / 4, 7 * math.pi / 4):
		out += f'<circle cx="{cx + (stone_r + 4) * math.cos(a):.1f}" cy="{top - 10 + (stone_r + 4) * math.sin(a):.1f}" r="5" fill="{tone}"/>'
	return out


def _band(tone: str, s: float, pave: bool, full: bool = False) -> str:
	cx, cy = 600, 600
	out = (
		f'<ellipse cx="{cx}" cy="{cy}" rx="280" ry="280" fill="none" stroke="{tone}" stroke-width="{26 + 14 * s:.0f}"/>'
		f'<ellipse cx="{cx}" cy="{cy}" rx="280" ry="280" fill="none" stroke="{GROUND}" stroke-width="2" opacity=".5"/>'
	)
	if pave:
		n = 40 if full else 18
		start = 0 if full else math.pi + math.pi / 4
		span = 2 * math.pi if full else math.pi / 2
		for i in range(n):
			a = start + span * i / n + (0 if full else 0)
			out += f'<circle cx="{cx + 280 * math.cos(a):.1f}" cy="{cy + 280 * math.sin(a):.1f}" r="9" fill="#EFE8DA" opacity=".9"/>'
	return out


def _necklace(tone: str, s: float, stones: bool, pendant: str | None, pearls: bool = False) -> str:
	# catenary-ish arc from the top corners
	x0, x1, y0 = 200, 1000, 180
	sag = 560 + 80 * s
	path = f"M{x0} {y0} Q600 {y0 + sag * 2 - 160} {x1} {y0}"
	out = f'<path d="{path}" fill="none" stroke="{tone}" stroke-width="{4 if not pearls else 2}"/>'
	n = 34 if not pearls else 26
	for i in range(1, n):
		t = i / n
		x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * 600 + t**2 * x1
		y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * (y0 + sag * 2 - 160) + t**2 * y0
		if pearls:
			out += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="22" fill="#EFE8DA" opacity=".92"/><circle cx="{x - 6:.1f}" cy="{y - 7:.1f}" r="6" fill="#FFFFFF" opacity=".7"/>'
		elif stones:
			r = 10 + 16 * math.sin(math.pi * t)
			out += _stone(x, y, r)
	if pendant == "emerald":
		out += f'<rect x="540" y="{y0 + sag - 90}" width="120" height="160" rx="10" fill="none" stroke="#7FA98A" stroke-width="3"/><rect x="565" y="{y0 + sag - 60}" width="70" height="100" rx="6" fill="none" stroke="#7FA98A" stroke-width="1.5" opacity=".7"/>'
	elif pendant == "monogram":
		out += f'<text x="600" y="{y0 + sag + 20}" text-anchor="middle" font-family="serif" font-size="170" fill="{tone}" opacity=".95">M</text>'
	elif pendant == "pave":
		out += f'<circle cx="600" cy="{y0 + sag - 10}" r="70" fill="none" stroke="{tone}" stroke-width="3"/>' + "".join(
			f'<circle cx="{600 + 45 * math.cos(a):.1f}" cy="{y0 + sag - 10 + 45 * math.sin(a):.1f}" r="7" fill="#EFE8DA"/>' for a in (i * math.pi / 6 for i in range(12))
		)
	return out


def _earrings(tone: str, s: float, studs: bool, color: str = "#EFE8DA") -> str:
	out = ""
	for cx in (420, 780):
		if studs:
			out += _stone(cx, 600, 60 + 30 * s, color) + f'<circle cx="{cx}" cy="600" r="{70 + 30 * s:.0f}" fill="none" stroke="{tone}" stroke-width="3"/>'
		else:
			out += (
				f'<path d="M{cx} 330 q-40 60 0 110 q40 -50 0 -110" fill="none" stroke="{tone}" stroke-width="3"/>'
				f'<line x1="{cx}" y1="440" x2="{cx}" y2="560" stroke="{tone}" stroke-width="3"/>'
				+ _stone(cx, 640, 90, color)
				+ f'<path d="M{cx - 40} 700 L{cx} 860 L{cx + 40} 700" fill="none" stroke="{tone}" stroke-width="2"/>'
			)
	return out


def _bracelet(tone: str, s: float, stones: bool, cuff: bool = False, color: str = "#EFE8DA") -> str:
	cx, cy = 600, 600
	if cuff:
		return (
			f'<path d="M{cx - 330} {cy + 120} A330 330 0 1 1 {cx + 330} {cy + 120}" fill="none" stroke="{tone}" stroke-width="{60 + 20 * s:.0f}" stroke-linecap="round"/>'
			f'<path d="M{cx - 330} {cy + 120} A330 330 0 1 1 {cx + 330} {cy + 120}" fill="none" stroke="{GROUND}" stroke-width="1.5" opacity=".6"/>'
		)
	out = f'<ellipse cx="{cx}" cy="{cy}" rx="330" ry="240" fill="none" stroke="{tone}" stroke-width="{6 if stones else 22}"/>'
	if stones:
		for i in range(36):
			a = i * math.pi / 18
			out += _stone(cx + 330 * math.cos(a), cy + 240 * math.sin(a), 16, color)
	return out


def _brooch(tone: str, s: float) -> str:
	out = ""
	for i in range(9):
		a = i * 2 * math.pi / 9
		r = 120 + 30 * math.sin(i * 1.7)
		out += _stone(600 + r * math.cos(a), 600 + r * math.sin(a), 34 + 10 * ((i * 7) % 3))
	out += _stone(600, 600, 70)
	out += f'<path d="M430 760 q170 80 340 0" fill="none" stroke="{tone}" stroke-width="3"/>'
	return out


def _cufflinks(tone: str) -> str:
	return "".join(
		f'<rect x="{cx - 90}" y="510" width="180" height="180" rx="6" fill="#0E0E0D" stroke="{tone}" stroke-width="4"/>'
		f'<rect x="{cx - 60}" y="540" width="120" height="120" rx="4" fill="none" stroke="{tone}" stroke-width="1.5" opacity=".7"/>'
		for cx in (420, 780)
	)


def _strap(tone: str) -> str:
	return (
		f'<path d="M420 160 L780 160 L760 1040 L440 1040 Z" fill="none" stroke="#7A5A3A" stroke-width="5"/>'
		+ "".join(f'<path d="M{440 + (i % 2) * 20} {220 + i * 46} l{300 - (i % 2) * 40} 0" stroke="#7A5A3A" stroke-width="1.2" opacity=".5"/>' for i in range(17))
		+ f'<rect x="560" y="150" width="80" height="34" rx="6" fill="none" stroke="{tone}" stroke-width="4"/>'
	)


def _case() -> str:
	return (
		f'<rect x="240" y="330" width="720" height="460" rx="28" fill="none" stroke="{GOLD}" stroke-width="4"/>'
		f'<rect x="240" y="330" width="720" height="150" rx="28" fill="none" stroke="{GOLD}" stroke-width="1.5" opacity=".6"/>'
		f'<line x1="600" y1="330" x2="600" y2="480" stroke="{GOLD}" stroke-width="1.5" opacity=".6"/>'
		f'<rect x="560" y="560" width="80" height="40" rx="6" fill="{GOLD}" opacity=".85"/>'
	)


def _square() -> str:
	return (
		f'<path d="M260 860 L600 300 L940 860 Z" fill="none" stroke="{GOLD}" stroke-width="3"/>'
		f'<path d="M340 860 L600 420 L860 860" fill="none" stroke="{GOLD}" stroke-width="1.2" opacity=".6"/>'
		f'<path d="M420 860 L600 540 L780 860" fill="none" stroke="{GOLD}" stroke-width="1.2" opacity=".4"/>'
	)


def _service(code: str) -> str:
	return (
		f'<circle cx="600" cy="600" r="260" fill="none" stroke="{GOLD}" stroke-width="2"/>'
		f'<text x="600" y="650" text-anchor="middle" font-family="serif" font-size="150" fill="{GOLD}">{code[-3:]}</text>'
	)


def product_svg(item_code: str, item_name: str, item_group: str, metal: str | None, carat: float, stones: str | None) -> str:
	"""SVG markup (1200×1200) for a demo item."""
	tone = _tone(metal)
	s = _seed(item_code)
	name = (item_name or "").lower()
	stones_l = (stones or "").lower()
	body: str
	if item_group == "Timepieces":
		body = _watch(tone, s, "bezel" in stones_l)
	elif item_group == "Bridal":
		if "band" in name:
			body = _band(tone, s, "eternity" in name, "full" in name)
		elif "three" in name or "trinity" in name:
			body = _ring(tone, s, carat, three=True)
		else:
			body = _ring(tone, s, carat, halo="halo" in name)
	elif item_group == "High Jewellery":
		if "earring" in name:
			body = _earrings(tone, s, False, "#6F8FC9" if "sapphire" in stones_l else "#EFE8DA")
		elif "ring" in name and "earring" not in name:
			body = _ring(tone, s, carat)
		elif "bracelet" in name:
			body = _bracelet(tone, s, True, color="#7FA98A" if "tsavorite" in stones_l else "#EFE8DA")
		elif "brooch" in name:
			body = _brooch(tone, s)
		elif "pearl" in name or "pearl" in stones_l:
			body = _necklace(tone, s, False, None, pearls=True)
		elif "emerald" in name:
			body = _necklace(tone, s, False, "emerald")
		else:
			body = _necklace(tone, s, True, None)
	elif item_group == "Accessories":
		if "chain" in name:
			body = _necklace(tone, s, False, None)
		elif "pendant" in name:
			body = _necklace(tone, s, False, "pave" if "pave" in name else "monogram")
		elif "stud" in name:
			body = _earrings(tone, s, True)
		elif "pearl" in name:
			body = _necklace(tone, s, False, None, pearls=True)
		elif "cuff bracelet" in name:
			body = _bracelet(tone, s, False, cuff=True)
		elif "cufflink" in name:
			body = _cufflinks(tone)
		elif "strap" in name:
			body = _strap(tone)
		elif "case" in name:
			body = _case()
		else:
			body = _square()
	else:
		body = _service(item_code)

	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200">'
		"<defs>"
		f'<radialGradient id="g" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#1B1916"/><stop offset="1" stop-color="{GROUND}"/></radialGradient>'
		"</defs>"
		'<rect width="1200" height="1200" fill="url(#g)"/>'
		f'<rect x="36" y="36" width="1128" height="1128" fill="none" stroke="{GOLD}" stroke-width="1" opacity=".25"/>'
		f"{body}"
		"</svg>"
	)
