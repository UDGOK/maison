"""Generated SVG product visuals for the Scents of Arabia catalogue (v1.3) — the same onyx
ground and gold line work as the CloudChaserz art (``setup.cloudchaserz.art._frame``), drawn as
fragrance objects: a flacon whose juice is tinted by the fragrance family, a boxed gift set, a
body-spray can, a roll-on oil vial, a counter display — and a small gold crescent, the brand's
mark, on every Arabian piece. Pure python, deterministic per item code."""

from __future__ import annotations

from html import escape

from maison_pos.setup.cloudchaserz.art import DIM, GOLD, GROUND, SURFACE, TEXT, _frame, _seed

FAMILY_TINTS = {
	"oud": "#8C5A2B",
	"attar": "#8C5A2B",
	"amber": "#C98A3A",
	"oriental": "#B06A3A",
	"spicy": "#B0503A",
	"woody": "#7A5A3A",
	"gourmand": "#C9A06E",
	"floral": "#C47A9A",
	"fruity": "#C4736A",
	"citrus": "#D3C35B",
	"aquatic": "#6F9FB8",
	"fresh": "#7FA98A",
	"musky": "#B8A090",
	"aldehyde": "#E2D2B0",
	"aromatic": "#8FA86A",
}


def _tint(family: str | None, code: str) -> str:
	f = (family or "").lower()
	for key, color in FAMILY_TINTS.items():
		if key in f:
			return color
	palette = ["#C9A96E", "#C47A9A", "#8C5A2B", "#6F9FB8", "#B06A3A", "#7FA98A"]
	return palette[_seed(code) % len(palette)]


def _crescent(x: int = 470, y: int = 90, r: int = 26) -> str:
	"""The brand's crescent — a gold disc with the ground bitten out of it."""
	return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{GOLD}" opacity=".9"/><circle cx="{x + r * 0.42:.0f}" cy="{y - r * 0.18:.0f}" r="{r * 0.86:.0f}" fill="{GROUND}"/>'


def _flacon(tint: str, code: str, label: str, tall: bool = True) -> str:
	g = f"t{_seed(code) % 1000}"
	h = 260 if tall else 200
	y = 450 - h
	return f"""<rect x="210" y="{y}" width="180" height="{h}" rx="14" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="222" y="{y + 12}" width="156" height="{h - 24}" rx="10" fill="none" stroke="{GOLD}" stroke-width=".6" opacity=".5"/>
<rect x="262" y="{y - 58}" width="76" height="62" rx="8" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="286" y="{y - 84}" width="28" height="30" rx="5" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="238" y="{y + h * 0.42:.0f}" width="124" height="{h * 0.3:.0f}" fill="{GROUND}" opacity=".5"/>
<text x="300" y="{y + h * 0.42 + h * 0.19:.0f}" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="20" letter-spacing="2" fill="{TEXT}">{escape(label)}</text>"""


def _giftset(tint: str, code: str, label: str) -> str:
	g = f"t{_seed(code) % 1000}"
	return f"""<rect x="150" y="200" width="300" height="220" rx="10" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="150" y="170" width="300" height="44" rx="8" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="290" y="170" width="20" height="250" fill="{GOLD}" opacity=".85"/>
<rect x="150" y="285" width="300" height="20" fill="{GOLD}" opacity=".85"/>
<rect x="196" y="236" width="70" height="140" rx="8" fill="url(#{g})" stroke="{GOLD}" stroke-width="1" opacity=".9"/>
<rect x="216" y="216" width="30" height="24" rx="4" fill="{GROUND}" stroke="{GOLD}" stroke-width="1"/>
<rect x="336" y="250" width="44" height="126" rx="8" fill="url(#{g})" stroke="{GOLD}" stroke-width="1" opacity=".7"/>
<rect x="392" y="266" width="36" height="110" rx="8" fill="url(#{g})" stroke="{GOLD}" stroke-width="1" opacity=".55"/>
<text x="300" y="470" text-anchor="middle" font-family="Jost, Helvetica, Arial, sans-serif" font-size="13" letter-spacing="5" fill="{GOLD}">{escape(label)}</text>"""


def _spray(tint: str, code: str) -> str:
	g = f"t{_seed(code) % 1000}"
	return f"""<rect x="252" y="130" width="96" height="310" rx="22" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="268" y="100" width="64" height="40" rx="8" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="290" y="80" width="20" height="22" rx="4" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="268" y="250" width="64" height="120" fill="{GROUND}" opacity=".45"/>
<path d="M300 420 Q300 400 300 380" stroke="{GOLD}" stroke-width="1" opacity=".5"/>"""


def _oil(tint: str, code: str) -> str:
	g = f"t{_seed(code) % 1000}"
	out = []
	for i, (x, dy, op) in enumerate(((196, 30, .55), (262, 0, 1.0), (334, 30, .7))):
		out.append(f'<rect x="{x}" y="{170 + dy}" width="50" height="220" rx="12" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.3" opacity="{op}"/>')
		out.append(f'<rect x="{x + 8}" y="{140 + dy}" width="34" height="34" rx="6" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.2" opacity="{op}"/>')
		out.append(f'<circle cx="{x + 25}" cy="{362 + dy}" r="9" fill="{GROUND}" stroke="{GOLD}" stroke-width="1" opacity="{op}"/>')
	return "".join(out)


def _display(tint: str, code: str, count: str) -> str:
	g = f"t{_seed(code) % 1000}"
	out = [f'<path d="M170 420 L200 170 L400 170 L430 420 Z" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>']
	for row in range(4):
		y = 200 + row * 52
		out.append(f'<line x1="{206 + row * 3}" y1="{y + 32}" x2="{394 - row * 3}" y2="{y + 32}" stroke="{GOLD}" stroke-width="1" opacity=".7"/>')
		for col in range(7):
			x = 214 + col * 25 + row * 1
			out.append(f'<rect x="{x}" y="{y}" width="14" height="30" rx="4" fill="url(#{g})" stroke="{GOLD}" stroke-width=".6" opacity=".85"/>')
	out.append(f'<text x="300" y="460" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="18" letter-spacing="3" fill="{TEXT}">{escape(count)}</text>')
	return "".join(out)


def _service(name: str) -> str:
	if "gift" in name.lower():
		amount = name.split("$")[-1] if "$" in name else ""
		return f"""<rect x="150" y="200" width="300" height="190" rx="18" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="150" y="240" width="300" height="28" fill="{GOLD}" opacity=".9"/>
<text x="300" y="350" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="44" fill="{TEXT}">${escape(amount)}</text>
<text x="176" y="226" font-family="Jost, sans-serif" font-size="12" letter-spacing="4" fill="{GOLD}">GIFT CARD</text>"""
	return f"""<circle cx="300" cy="280" r="110" fill="none" stroke="{GOLD}" stroke-width="1.5"/><path d="M250 280 L290 320 L360 240" fill="none" stroke="{GOLD}" stroke-width="6" stroke-linecap="round"/>"""


def _size_label(name: str) -> str:
	import re

	m = re.search(r"(\d+(?:\.\d+)?)\s*oz", name)
	return f"{m.group(1)} oz" if m else ""


def product_svg(
	item_code: str,
	item_name: str,
	item_group: str,
	brand: str | None = None,
	concentration: str | None = None,
	gender: str | None = None,
	family: str | None = None,
	origin: str | None = None,
	caption: bool = False,
) -> str:
	tint = _tint(family, item_code)
	conc = (concentration or "").upper()
	if item_group == "Services":
		inner = _service(item_name)
	elif item_group == "Displays & Fixtures":
		inner = _display(tint, item_code, "144 VIALS" if "144" in item_name else "36 VIALS")
	elif item_group == "Perfume Oils":
		inner = _oil(tint, item_code)
	elif item_group == "Body Sprays & Mists":
		inner = _spray(tint, item_code)
	elif item_group == "Gift Sets":
		inner = _giftset(tint, item_code, (brand or "").upper())
	else:
		label = conc if conc in ("EDP", "EDT") else ("PARFUM" if "PARFUM" in conc else conc[:7])
		inner = _flacon(tint, item_code, label or _size_label(item_name), tall=(gender != "Men"))
	if origin == "Arabian":
		inner += _crescent()
	return _frame(inner, item_code, item_name, item_group, brand, tint, caption=caption)
