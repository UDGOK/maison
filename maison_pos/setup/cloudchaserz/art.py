"""Generated SVG product visuals for the CloudChaserz catalogue (v0.6 N) — onyx ground, gold
line work, a flavour-tinted accent per item so tiles and the web shop look finished without
photography. Pure python, deterministic per item code."""

from __future__ import annotations

import hashlib
from html import escape

W, H = 600, 600
GROUND = "#0B0B0A"
SURFACE = "#141311"
LINE = "#36322C"
GOLD = "#C9A96E"
TEXT = "#EFE8DA"
DIM = "#7D7668"

FLAVOR_TINTS = {
	"mint": "#7FA98A",
	"blue": "#6F8FB8",
	"razz": "#8E6FB8",
	"berry": "#8E6FB8",
	"grape": "#8E6FB8",
	"watermelon": "#C4736A",
	"strawberry": "#C4736A",
	"cherry": "#B8566A",
	"peach": "#D3A55B",
	"mango": "#D3A55B",
	"apple": "#9FB36A",
	"lemon": "#D3C35B",
	"lime": "#9FB36A",
	"cola": "#8C6A4A",
	"kiwi": "#9FB36A",
	"aloe": "#7FA98A",
	"cream": "#E2D2B0",
	"custard": "#E2D2B0",
	"kustard": "#E2D2B0",
	"vct": "#C9A96E",
	"pog": "#D3A55B",
	"lava": "#C4736A",
	"rainbow": "#B87FB8",
	"blackberry": "#5E4A8E",
	"blueberry": "#6F8FB8",
	"gold": "#C9A96E",
	"red": "#B8566A",
	"green": "#7FA98A",
	"white": "#E9ECE6",
	"honey": "#D3A55B",
}


def _seed(code: str) -> int:
	return int(hashlib.sha1(code.encode()).hexdigest()[:8], 16)


def _tint(flavor: str | None, code: str) -> str:
	f = (flavor or "").lower()
	for key, color in FLAVOR_TINTS.items():
		if key in f:
			return color
	palette = ["#C9A96E", "#7FA98A", "#6F8FB8", "#8E6FB8", "#C4736A", "#D3A55B"]
	return palette[_seed(code) % len(palette)]


def _frame(inner: str, code: str, name: str, group: str, brand: str | None, tint: str) -> str:
	brand_line = escape((brand or "").upper())
	name_line = escape(name if len(name) <= 34 else name[:33] + "…")
	return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">
<defs>
<radialGradient id="g{_seed(code) % 1000}" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="{SURFACE}"/><stop offset="1" stop-color="{GROUND}"/></radialGradient>
<linearGradient id="t{_seed(code) % 1000}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{tint}" stop-opacity=".95"/><stop offset="1" stop-color="{tint}" stop-opacity=".45"/></linearGradient>
</defs>
<rect width="{W}" height="{H}" fill="url(#g{_seed(code) % 1000})"/>
<rect x="24" y="24" width="{W-48}" height="{H-48}" fill="none" stroke="{LINE}" stroke-width="1"/>
<g>{inner}</g>
<text x="300" y="520" text-anchor="middle" font-family="Jost, Helvetica, Arial, sans-serif" font-size="13" letter-spacing="5" fill="{GOLD}">{brand_line}</text>
<text x="300" y="548" text-anchor="middle" font-family="Jost, Helvetica, Arial, sans-serif" font-size="17" fill="{TEXT}">{name_line}</text>
<text x="300" y="572" text-anchor="middle" font-family="Jost, Helvetica, Arial, sans-serif" font-size="11" letter-spacing="4" fill="{DIM}">{escape(group.upper())}</text>
</svg>"""


def _disposable(tint: str, code: str, puffs: int | None) -> str:
	g = f"t{_seed(code) % 1000}"
	return f"""<rect x="250" y="110" width="100" height="330" rx="26" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="262" y="122" width="76" height="200" rx="14" fill="{GROUND}" opacity=".35"/>
<rect x="282" y="90" width="36" height="26" rx="8" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<circle cx="300" cy="400" r="6" fill="{GOLD}"/>
<text x="300" y="240" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="22" fill="{TEXT}" opacity=".9">{(str(puffs // 1000) + 'K') if puffs else ''}</text>"""


def _bottle(tint: str, code: str, ml: float) -> str:
	g = f"t{_seed(code) % 1000}"
	h = 250 if ml >= 60 else 200
	y = 440 - h
	return f"""<rect x="215" y="{y}" width="170" height="{h}" rx="18" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="268" y="{y - 60}" width="64" height="64" rx="6" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="290" y="{y - 96}" width="20" height="40" rx="6" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="236" y="{y + 40}" width="128" height="110" fill="{GROUND}" opacity=".45"/>
<text x="300" y="{y + 112}" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="26" fill="{TEXT}">{int(ml) if ml else ''}<tspan font-size="12"> ml</tspan></text>"""


def _device(tint: str, code: str) -> str:
	g = f"t{_seed(code) % 1000}"
	return f"""<rect x="225" y="120" width="150" height="320" rx="22" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="245" y="150" width="110" height="150" rx="10" fill="url(#{g})"/>
<rect x="262" y="330" width="76" height="8" rx="4" fill="{GOLD}" opacity=".8"/>
<circle cx="300" cy="385" r="16" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="270" y="96" width="60" height="26" rx="8" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>"""


def _pod(tint: str, code: str) -> str:
	g = f"t{_seed(code) % 1000}"
	out = []
	for i, x in enumerate((180, 262, 344)):
		out.append(f'<rect x="{x}" y="{170 + i * 10}" width="76" height="220" rx="14" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.2" opacity="{0.7 + i * 0.15}"/>')
		out.append(f'<circle cx="{x + 38}" cy="{360 + i * 10}" r="10" fill="{GROUND}" stroke="{GOLD}"/>')
	return "".join(out)


def _glass(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if "rig" in n or "banger" in n:
		return f"""<path d="M300 120 L300 250 Q300 280 270 300 L230 330 Q200 360 230 400 L370 400 Q400 360 370 330 L330 300 Q300 280 300 250" fill="url(#{g})" fill-opacity=".45" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 250 L400 200 L430 160" fill="none" stroke="{GOLD}" stroke-width="1.5"/><rect x="418" y="140" width="28" height="30" rx="4" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<ellipse cx="300" cy="400" rx="70" ry="10" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.2"/>"""
	if "bubbler" in n or "pipe" in n or "chillum" in n or "bowl" in n or "downstem" in n or "carb" in n or "tool" in n:
		return f"""<path d="M180 330 Q200 260 280 250 L400 250 Q440 250 440 290 Q440 330 400 330 L240 330 Q200 330 180 330 Z" fill="url(#{g})" fill-opacity=".5" stroke="{GOLD}" stroke-width="1.5"/>
<circle cx="400" cy="250" r="34" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/><circle cx="400" cy="250" r="14" fill="{GROUND}"/>"""
	return f"""<path d="M270 110 L330 110 L330 250 Q420 300 400 400 Q390 430 300 430 Q210 430 200 400 Q180 300 270 250 Z" fill="url(#{g})" fill-opacity=".45" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="262" y="90" width="76" height="26" rx="6" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 300 L380 230" stroke="{GOLD}" stroke-width="1.5"/><circle cx="388" cy="222" r="16" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M205 380 Q300 360 395 380" fill="none" stroke="{GOLD}" stroke-width="1" opacity=".6"/>"""


def _hookah(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if any(k in n for k in ("250g", "100g", "50g", "shisha", "coal", "bowl", "hose", "tips", "lotus")):
		return f"""<rect x="190" y="190" width="220" height="200" rx="16" fill="url(#{g})" fill-opacity=".6" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="190" y="160" width="220" height="44" rx="10" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="214" y="240" width="172" height="96" fill="{GROUND}" opacity=".5"/>
<text x="300" y="300" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="20" fill="{TEXT}">{escape(name.split()[-1]) if any(ch.isdigit() for ch in name.split()[-1]) else ''}</text>"""
	return f"""<path d="M300 90 L300 150" stroke="{GOLD}" stroke-width="2"/><rect x="270" y="70" width="60" height="30" rx="8" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 150 L300 300" stroke="{GOLD}" stroke-width="6"/>
<path d="M240 300 Q300 260 360 300 Q380 380 300 420 Q220 380 240 300 Z" fill="url(#{g})" fill-opacity=".5" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 250 Q420 250 430 360 Q430 440 380 450" fill="none" stroke="{GOLD}" stroke-width="3" opacity=".8"/>"""


def _kratom(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if "shot" in n:
		return f"""<rect x="255" y="150" width="90" height="260" rx="20" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/><rect x="270" y="120" width="60" height="40" rx="6" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>"""
	if "capsule" in n:
		out = [f'<rect x="200" y="150" width="200" height="260" rx="18" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>', f'<rect x="200" y="120" width="200" height="44" rx="10" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>']
		for i in range(5):
			out.append(f'<rect x="{220 + i * 34}" y="{260 + (i % 2) * 14}" width="26" height="60" rx="13" fill="url(#{g})" stroke="{GOLD}" stroke-width="1"/>')
		return "".join(out)
	return f"""<path d="M200 150 L400 150 L420 410 L180 410 Z" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="196" y="130" width="208" height="30" rx="6" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 200 Q360 240 300 340 Q240 240 300 200 Z" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.2"/><path d="M300 200 L300 340" stroke="{GOLD}" stroke-width="1"/>"""


def _cbd(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if "tincture" in n:
		return _bottle(tint, code, 30)
	if "gumm" in n:
		out = [f'<rect x="190" y="160" width="220" height="250" rx="18" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>', f'<rect x="190" y="130" width="220" height="40" rx="10" fill="{GROUND}" stroke="{GOLD}" stroke-width="1.5"/>']
		for i, (x, y) in enumerate(((240, 250), (300, 230), (360, 260), (270, 320), (330, 330))):
			out.append(f'<path d="M{x-20} {y+12} Q{x-20} {y-18} {x} {y-18} Q{x+20} {y-18} {x+20} {y+12} Q{x} {y+30} {x-20} {y+12} Z" fill="url(#{g})" stroke="{GOLD}" stroke-width="1" opacity="{0.6 + i * 0.08}"/>')
		return "".join(out)
	return f"""<path d="M300 130 Q330 200 300 290 Q270 200 300 130 Z M300 290 Q240 250 200 270 Q250 300 300 290 Z M300 290 Q360 250 400 270 Q350 300 300 290 Z M300 290 L300 400" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.3"/>"""


def _papers(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if "cone" in n or "pack" in n and ("backwoods" in n or "swisher" in n):
		out = []
		for i in range(3):
			out.append(f'<path d="M{230 + i * 40} 400 L{250 + i * 40} 160 L{262 + i * 40} 160 L{280 + i * 40} 400 Z" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.2" opacity="{0.7 + i * 0.1}"/>')
		return "".join(out)
	return f"""<rect x="190" y="190" width="220" height="150" rx="8" fill="url(#{g})" fill-opacity=".8" stroke="{GOLD}" stroke-width="1.5" transform="rotate(-6 300 265)"/>
<rect x="204" y="204" width="192" height="122" fill="{GROUND}" opacity=".35" transform="rotate(-6 300 265)"/>
<path d="M214 230 L386 230 M214 260 L386 260 M214 290 L386 290" stroke="{GOLD}" stroke-width="1" opacity=".6" transform="rotate(-6 300 265)"/>"""


def _accessory(tint: str, code: str, name: str) -> str:
	g = f"t{_seed(code) % 1000}"
	n = name.lower()
	if "lighter" in n or "torch" in n or "butane" in n:
		return f"""<rect x="262" y="180" width="76" height="240" rx="12" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/><rect x="276" y="150" width="48" height="40" rx="6" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<path d="M300 150 Q280 110 300 90 Q320 110 300 150 Z" fill="{GOLD}" opacity=".9"/>"""
	if "grinder" in n:
		return f"""<ellipse cx="300" cy="230" rx="110" ry="34" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/><path d="M190 230 L190 330 Q300 380 410 330 L410 230" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/><ellipse cx="300" cy="330" rx="110" ry="34" fill="none" stroke="{GOLD}" stroke-width="1" opacity=".6"/>"""
	if "battery" in n or "charger" in n or "cable" in n:
		return f"""<rect x="236" y="150" width="58" height="260" rx="10" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5"/><rect x="306" y="150" width="58" height="260" rx="10" fill="url(#{g})" stroke="{GOLD}" stroke-width="1.5" opacity=".8"/><rect x="256" y="136" width="18" height="14" fill="{GOLD}"/><rect x="326" y="136" width="18" height="14" fill="{GOLD}"/>"""
	if "tee" in n or "cap" in n:
		return f"""<path d="M220 170 L260 140 L340 140 L380 170 L420 230 L380 250 L380 400 L220 400 L220 250 L180 230 Z" fill="url(#{g})" fill-opacity=".8" stroke="{GOLD}" stroke-width="1.5"/>
<text x="300" y="300" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="16" letter-spacing="2" fill="{TEXT}">CLOUDCHASERZ</text>"""
	return f"""<rect x="200" y="180" width="200" height="220" rx="16" fill="url(#{g})" fill-opacity=".7" stroke="{GOLD}" stroke-width="1.5"/><rect x="200" y="150" width="200" height="40" rx="10" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>"""


def _service(tint: str, code: str, name: str) -> str:
	if "gift" in name.lower():
		amount = name.split("$")[-1] if "$" in name else ""
		return f"""<rect x="150" y="200" width="300" height="190" rx="18" fill="{SURFACE}" stroke="{GOLD}" stroke-width="1.5"/>
<rect x="150" y="240" width="300" height="28" fill="{GOLD}" opacity=".9"/>
<text x="300" y="350" text-anchor="middle" font-family="Unbounded, Arial Black, sans-serif" font-weight="900" font-size="44" fill="{TEXT}">${escape(amount)}</text>
<text x="176" y="226" font-family="Jost, sans-serif" font-size="12" letter-spacing="4" fill="{GOLD}">GIFT CARD</text>"""
	return f"""<circle cx="300" cy="280" r="110" fill="none" stroke="{GOLD}" stroke-width="1.5"/><path d="M250 280 L290 320 L360 240" fill="none" stroke="{GOLD}" stroke-width="6" stroke-linecap="round"/>"""


def product_svg(item_code: str, item_name: str, item_group: str, brand: str | None = None, flavor: str | None = None, puffs: int | None = None, ml: float | None = None) -> str:
	tint = _tint(flavor, item_code)
	n = item_name.lower()
	if item_group == "Disposables":
		if puffs is None:
			import re

			m = re.search(r"(\d+)K", item_name)
			puffs = int(m.group(1)) * 1000 if m else None
		inner = _disposable(tint, item_code, puffs)
	elif item_group == "E-Liquid":
		if ml is None:
			import re

			m = re.search(r"(\d+)ml", item_name)
			ml = float(m.group(1)) if m else 60
		inner = _bottle(tint, item_code, ml)
	elif item_group == "Devices & Mods":
		inner = _device(tint, item_code)
	elif item_group == "Pods & Coils":
		inner = _pod(tint, item_code)
	elif item_group == "Glass & Rigs":
		inner = _glass(tint, item_code, item_name)
	elif item_group == "Hookah & Shisha":
		inner = _hookah(tint, item_code, item_name)
	elif item_group == "Kratom":
		inner = _kratom(tint, item_code, item_name)
	elif item_group == "CBD & Hemp":
		inner = _cbd(tint, item_code, item_name)
	elif item_group == "Rolling & Papers":
		inner = _papers(tint, item_code, item_name)
	elif item_group == "Services":
		inner = _service(tint, item_code, item_name)
	else:
		inner = _accessory(tint, item_code, item_name)
	return _frame(inner, item_code, item_name, item_group, brand, tint)
