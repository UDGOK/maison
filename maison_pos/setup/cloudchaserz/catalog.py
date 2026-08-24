"""CloudChaserz catalogue (v0.6 N): ~120 smoke-shop items across Disposables, E-Liquid,
Devices & Mods, Pods & Coils, Glass & Rigs, Hookah & Shisha, Kratom, CBD & Hemp, Rolling &
Papers, Accessories, Services / Gift Card — MSRP + cost, EAN-13, generated SVG art, opening
stock in every store and in the HOU-WH main warehouse.

Age-restricted groups default to ``maison_age_restricted = 1`` (21+)."""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import cint, flt

from maison_pos.identifiers import ean13_for
from maison_pos.setup.cloudchaserz import ABBR, COMPANY, CURRENCY, DEMO_PASSWORD, DEMO_STOCK_REMARK, PRICE_LIST
from maison_pos.setup.install_v06 import AGE_RESTRICTED_GROUPS

ITEM_GROUPS: list[str] = [
	"Disposables",
	"E-Liquid",
	"Devices & Mods",
	"Pods & Coils",
	"Glass & Rigs",
	"Hookah & Shisha",
	"Kratom",
	"CBD & Hemp",
	"Rolling & Papers",
	"Accessories",
	"Services",
]

# item group -> department (Item.maison_department)
GROUP_DEPARTMENT: dict[str, str] = {
	"Disposables": "Vape",
	"E-Liquid": "Vape",
	"Devices & Mods": "Vape",
	"Pods & Coils": "Vape",
	"Glass & Rigs": "Glass",
	"Hookah & Shisha": "Hookah",
	"Kratom": "Kratom & CBD",
	"CBD & Hemp": "Kratom & CBD",
	"Rolling & Papers": "Accessories",
	"Accessories": "Accessories",
	"Services": "Services",
}

# serialized high-value glass is optional; the demo keeps everything qty-based
SERIALIZED: set[str] = set()


def _i(code: str, name: str, group: str, brand: str, rate: float, cost: float, *, flavor: Optional[str] = None, nic: float = 0, ml: float = 0, puffs: int = 0, stock: int = 12, wh: int = 60, msrp: Optional[float] = None, age: Optional[bool] = None) -> dict[str, Any]:
	return {
		"code": code,
		"name": name,
		"group": group,
		"department": GROUP_DEPARTMENT[group],
		"brand": brand,
		"flavor": flavor,
		"nic": nic,
		"ml": ml,
		"puffs": puffs,
		"rate": rate,
		"cost": cost,
		"msrp": msrp if msrp is not None else rate,
		"stock": stock,
		"wh": wh,
		"age": (group in AGE_RESTRICTED_GROUPS) if age is None else age,
	}


ITEMS: list[dict[str, Any]] = [
	# ---- Disposables (DSP) ------------------------------------------------------------
	_i("DSP-001", "Geek Bar Pulse 15K — Miami Mint", "Disposables", "Geek Bar", 24.99, 11.5, flavor="Miami Mint", nic=50, ml=16, puffs=15000, stock=24, wh=240),
	_i("DSP-002", "Geek Bar Pulse 15K — Blue Razz Ice", "Disposables", "Geek Bar", 24.99, 11.5, flavor="Blue Razz Ice", nic=50, ml=16, puffs=15000, stock=24, wh=240),
	_i("DSP-003", "Geek Bar Pulse 15K — Watermelon Ice", "Disposables", "Geek Bar", 24.99, 11.5, flavor="Watermelon Ice", nic=50, ml=16, puffs=15000, stock=20, wh=200),
	_i("DSP-004", "Geek Bar Pulse 15K — Sour Apple Ice", "Disposables", "Geek Bar", 24.99, 11.5, flavor="Sour Apple Ice", nic=50, ml=16, puffs=15000, stock=18, wh=180),
	_i("DSP-005", "Geek Bar Pulse 15K — Strawberry Mango", "Disposables", "Geek Bar", 24.99, 11.5, flavor="Strawberry Mango", nic=50, ml=16, puffs=15000, stock=18, wh=180),
	_i("DSP-006", "Geek Bar Pulse X 25K — Fcuking Fab", "Disposables", "Geek Bar", 27.99, 13.0, flavor="Fcuking Fab", nic=50, ml=18, puffs=25000, stock=16, wh=160),
	_i("DSP-007", "Geek Bar Pulse X 25K — Blackberry B-Pop", "Disposables", "Geek Bar", 27.99, 13.0, flavor="Blackberry B-Pop", nic=50, ml=18, puffs=25000, stock=14, wh=140),
	_i("DSP-008", "Lost Mary MO20000 Pro — Blue Razz Ice", "Disposables", "Lost Mary", 22.99, 10.5, flavor="Blue Razz Ice", nic=50, ml=18, puffs=20000, stock=20, wh=200),
	_i("DSP-009", "Lost Mary MO20000 Pro — Strawberry Ice", "Disposables", "Lost Mary", 22.99, 10.5, flavor="Strawberry Ice", nic=50, ml=18, puffs=20000, stock=18, wh=180),
	_i("DSP-010", "Lost Mary MO20000 Pro — Watermelon Lemon", "Disposables", "Lost Mary", 22.99, 10.5, flavor="Watermelon Lemon", nic=50, ml=18, puffs=20000, stock=16, wh=160),
	_i("DSP-011", "Lost Mary OS5000 — Cherry Cola", "Disposables", "Lost Mary", 15.99, 7.0, flavor="Cherry Cola", nic=50, ml=13, puffs=5000, stock=16, wh=150),
	_i("DSP-012", "Lost Mary OS5000 — Grape Jelly", "Disposables", "Lost Mary", 15.99, 7.0, flavor="Grape Jelly", nic=50, ml=13, puffs=5000, stock=14, wh=140),
	_i("DSP-013", "Elf Bar BC5000 — Watermelon Ice", "Disposables", "Elf Bar", 17.99, 8.0, flavor="Watermelon Ice", nic=50, ml=13, puffs=5000, stock=20, wh=200),
	_i("DSP-014", "Elf Bar BC5000 — Strawberry Kiwi", "Disposables", "Elf Bar", 17.99, 8.0, flavor="Strawberry Kiwi", nic=50, ml=13, puffs=5000, stock=18, wh=180),
	_i("DSP-015", "Elf Bar BC5000 — Peach Mango Watermelon", "Disposables", "Elf Bar", 17.99, 8.0, flavor="Peach Mango Watermelon", nic=50, ml=13, puffs=5000, stock=16, wh=160),
	_i("DSP-016", "Elf Bar Ice King 30K — Blue Razz Ice", "Disposables", "Elf Bar", 29.99, 14.0, flavor="Blue Razz Ice", nic=50, ml=18, puffs=30000, stock=12, wh=120),
	_i("DSP-017", "RAZ TN9000 — Blue Raz Ice", "Disposables", "RAZ", 21.99, 10.0, flavor="Blue Raz Ice", nic=50, ml=12, puffs=9000, stock=18, wh=180),
	_i("DSP-018", "RAZ TN9000 — Strawberry Burst", "Disposables", "RAZ", 21.99, 10.0, flavor="Strawberry Burst", nic=50, ml=12, puffs=9000, stock=16, wh=160),
	_i("DSP-019", "RAZ DC25000 — Miami Mint", "Disposables", "RAZ", 26.99, 12.5, flavor="Miami Mint", nic=50, ml=16, puffs=25000, stock=16, wh=160),
	_i("DSP-020", "RAZ DC25000 — Peach Ice", "Disposables", "RAZ", 26.99, 12.5, flavor="Peach Ice", nic=50, ml=16, puffs=25000, stock=14, wh=140),
	_i("DSP-021", "Flum Pebble 6000 — Aloe Grape", "Disposables", "Flum", 18.99, 8.5, flavor="Aloe Grape", nic=50, ml=14, puffs=6000, stock=14, wh=140),
	_i("DSP-022", "Flum Pebble 6000 — Strawberry Mango", "Disposables", "Flum", 18.99, 8.5, flavor="Strawberry Mango", nic=50, ml=14, puffs=6000, stock=14, wh=140),
	_i("DSP-023", "Breeze Prime 6000 — Strawberry Cream", "Disposables", "Breeze", 18.99, 8.5, flavor="Strawberry Cream", nic=50, ml=12, puffs=6000, stock=12, wh=120),
	_i("DSP-024", "Funky Republic Ti7000 — Rainbow Cloudz", "Disposables", "Funky Republic", 19.99, 9.0, flavor="Rainbow Cloudz", nic=50, ml=12.8, puffs=7000, stock=12, wh=120),
	_i("DSP-025", "Off-Stamp SW9000 Kit — Blueberry Ice", "Disposables", "Off-Stamp", 22.99, 10.5, flavor="Blueberry Ice", nic=50, ml=13, puffs=9000, stock=12, wh=120),
	_i("DSP-026", "Off-Stamp SW9000 Pod 2-pack — Strawberry Ice", "Disposables", "Off-Stamp", 19.99, 9.0, flavor="Strawberry Ice", nic=50, ml=13, puffs=9000, stock=12, wh=120),
	# ---- E-Liquid (ELQ) ---------------------------------------------------------------
	_i("ELQ-001", "Naked 100 Lava Flow 60ml 3mg", "E-Liquid", "Naked 100", 24.99, 11.0, flavor="Lava Flow", nic=3, ml=60, stock=8, wh=80),
	_i("ELQ-002", "Naked 100 Lava Flow 60ml 6mg", "E-Liquid", "Naked 100", 24.99, 11.0, flavor="Lava Flow", nic=6, ml=60, stock=8, wh=80),
	_i("ELQ-003", "Naked 100 Hawaiian POG 60ml 3mg", "E-Liquid", "Naked 100", 24.99, 11.0, flavor="Hawaiian POG", nic=3, ml=60, stock=8, wh=80),
	_i("ELQ-004", "Naked 100 Salt Lava Flow 30ml 35mg", "E-Liquid", "Naked 100", 19.99, 9.0, flavor="Lava Flow", nic=35, ml=30, stock=10, wh=100),
	_i("ELQ-005", "Naked 100 Salt Lava Flow 30ml 50mg", "E-Liquid", "Naked 100", 19.99, 9.0, flavor="Lava Flow", nic=50, ml=30, stock=10, wh=100),
	_i("ELQ-006", "Pachamama Fuji Apple Strawberry Nectarine 60ml 3mg", "E-Liquid", "Pachamama", 22.99, 10.0, flavor="Fuji Apple Strawberry Nectarine", nic=3, ml=60, stock=8, wh=80),
	_i("ELQ-007", "Pachamama Salts Fuji 30ml 25mg", "E-Liquid", "Pachamama", 18.99, 8.5, flavor="Fuji", nic=25, ml=30, stock=8, wh=80),
	_i("ELQ-008", "Coastal Clouds Apple Peach Strawberry 60ml 6mg", "E-Liquid", "Coastal Clouds", 22.99, 10.0, flavor="Apple Peach Strawberry", nic=6, ml=60, stock=6, wh=60),
	_i("ELQ-009", "Juice Head Peach Pear 100ml 3mg", "E-Liquid", "Juice Head", 26.99, 12.0, flavor="Peach Pear", nic=3, ml=100, stock=6, wh=60),
	_i("ELQ-010", "Juice Head Watermelon Lime 100ml 6mg", "E-Liquid", "Juice Head", 26.99, 12.0, flavor="Watermelon Lime", nic=6, ml=100, stock=6, wh=60),
	_i("ELQ-011", "Juice Head Salts Peach Pear 30ml 50mg", "E-Liquid", "Juice Head", 19.99, 9.0, flavor="Peach Pear", nic=50, ml=30, stock=8, wh=80),
	_i("ELQ-012", "Candy King Batch 100ml 3mg", "E-Liquid", "Candy King", 24.99, 11.0, flavor="Batch", nic=3, ml=100, stock=6, wh=60),
	_i("ELQ-013", "Cloud Nurdz Grape Apple 100ml 3mg", "E-Liquid", "Cloud Nurdz", 24.99, 11.0, flavor="Grape Apple", nic=3, ml=100, stock=6, wh=60),
	_i("ELQ-014", "Cloud Nurdz Salt Grape Apple 30ml 50mg", "E-Liquid", "Cloud Nurdz", 18.99, 8.5, flavor="Grape Apple", nic=50, ml=30, stock=8, wh=80),
	_i("ELQ-015", "Twist Pink Punch Lemonade 60ml 0mg", "E-Liquid", "Twist", 21.99, 9.5, flavor="Pink Punch Lemonade", nic=0, ml=60, stock=6, wh=60),
	_i("ELQ-016", "Twist Pink Punch Lemonade 60ml 6mg", "E-Liquid", "Twist", 21.99, 9.5, flavor="Pink Punch Lemonade", nic=6, ml=60, stock=6, wh=60),
	_i("ELQ-017", "Vapetasia Killer Kustard 100ml 3mg", "E-Liquid", "Vapetasia", 24.99, 11.0, flavor="Killer Kustard", nic=3, ml=100, stock=6, wh=60),
	_i("ELQ-018", "Pod Juice 55 Blue Razz Ice 30ml 55mg", "E-Liquid", "Pod Juice", 19.99, 9.0, flavor="Blue Razz Ice", nic=55, ml=30, stock=8, wh=80),
	_i("ELQ-019", "Ripe Vapes VCT 60ml 3mg", "E-Liquid", "Ripe Vapes", 24.99, 11.0, flavor="VCT", nic=3, ml=60, stock=6, wh=60),
	_i("ELQ-020", "Ripe Vapes VCT Salt 30ml 35mg", "E-Liquid", "Ripe Vapes", 19.99, 9.0, flavor="VCT", nic=35, ml=30, stock=8, wh=80),
	# ---- Devices & Mods (DEV) ---------------------------------------------------------
	_i("DEV-001", "SMOK Nord 5 Kit", "Devices & Mods", "SMOK", 39.99, 19.0, stock=6, wh=40),
	_i("DEV-002", "SMOK RPM 5 Pro Kit", "Devices & Mods", "SMOK", 49.99, 24.0, stock=4, wh=30),
	_i("DEV-003", "SMOK Arcfox 230W Mod", "Devices & Mods", "SMOK", 69.99, 34.0, stock=3, wh=20),
	_i("DEV-004", "Vaporesso XROS 4 Kit", "Devices & Mods", "Vaporesso", 29.99, 14.0, stock=8, wh=60),
	_i("DEV-005", "Vaporesso XROS 4 Mini Kit", "Devices & Mods", "Vaporesso", 24.99, 11.5, stock=8, wh=60),
	_i("DEV-006", "Vaporesso Luxe XR Max Kit", "Devices & Mods", "Vaporesso", 44.99, 21.0, stock=4, wh=30),
	_i("DEV-007", "Vaporesso Gen 200 Kit", "Devices & Mods", "Vaporesso", 59.99, 28.0, stock=3, wh=20),
	_i("DEV-008", "Geekvape Aegis Legend 3 Kit", "Devices & Mods", "Geekvape", 79.99, 38.0, stock=3, wh=20),
	_i("DEV-009", "Geekvape Wenax Q Mini Kit", "Devices & Mods", "Geekvape", 24.99, 11.5, stock=8, wh=60),
	_i("DEV-010", "Geekvape Sonder U Kit", "Devices & Mods", "Geekvape", 22.99, 10.5, stock=8, wh=60),
	_i("DEV-011", "Uwell Caliburn G3 Kit", "Devices & Mods", "Uwell", 34.99, 16.5, stock=6, wh=40),
	_i("DEV-012", "Uwell Caliburn A3S Kit", "Devices & Mods", "Uwell", 27.99, 13.0, stock=6, wh=40),
	_i("DEV-013", "Voopoo Drag 5 Kit", "Devices & Mods", "Voopoo", 69.99, 34.0, stock=3, wh=20),
	_i("DEV-014", "Voopoo Argus P2 Kit", "Devices & Mods", "Voopoo", 29.99, 14.0, stock=6, wh=40),
	_i("DEV-015", "Lost Vape Ursa Nano Pro 2 Kit", "Devices & Mods", "Lost Vape", 34.99, 16.5, stock=5, wh=30),
	_i("DEV-016", "Yocan UNI Pro 510 Battery", "Devices & Mods", "Yocan", 29.99, 13.0, stock=6, wh=40),
	_i("DEV-017", "Ooze Twist Slim Pen 2.0 510 Battery", "Devices & Mods", "Ooze", 19.99, 8.5, stock=10, wh=80),
	# ---- Pods & Coils (POD) -----------------------------------------------------------
	_i("POD-001", "Vaporesso XROS Pod 0.6Ω 4-pack", "Pods & Coils", "Vaporesso", 14.99, 6.5, stock=12, wh=120),
	_i("POD-002", "Vaporesso XROS Pod 0.8Ω 4-pack", "Pods & Coils", "Vaporesso", 14.99, 6.5, stock=12, wh=120),
	_i("POD-003", "Vaporesso XROS Pod 1.0Ω 4-pack", "Pods & Coils", "Vaporesso", 14.99, 6.5, stock=10, wh=100),
	_i("POD-004", "SMOK Nord 5 Coil 0.2Ω 5-pack", "Pods & Coils", "SMOK", 16.99, 7.5, stock=10, wh=100),
	_i("POD-005", "SMOK RPM 3 Coil 0.23Ω 5-pack", "Pods & Coils", "SMOK", 16.99, 7.5, stock=8, wh=80),
	_i("POD-006", "SMOK TFV18 Mesh Coil 0.33Ω 3-pack", "Pods & Coils", "SMOK", 15.99, 7.0, stock=6, wh=60),
	_i("POD-007", "Uwell Caliburn G3 Pod 0.9Ω 2-pack", "Pods & Coils", "Uwell", 9.99, 4.5, stock=12, wh=120),
	_i("POD-008", "Uwell Caliburn G Coil 0.8Ω 4-pack", "Pods & Coils", "Uwell", 13.99, 6.0, stock=10, wh=100),
	_i("POD-009", "Geekvape B Series Coil 0.4Ω 5-pack", "Pods & Coils", "Geekvape", 15.99, 7.0, stock=8, wh=80),
	_i("POD-010", "Geekvape Wenax Q Pod 0.8Ω 3-pack", "Pods & Coils", "Geekvape", 11.99, 5.0, stock=10, wh=100),
	_i("POD-011", "Voopoo PnP-X Coil 0.3Ω 5-pack", "Pods & Coils", "Voopoo", 16.99, 7.5, stock=8, wh=80),
	_i("POD-012", "Voopoo Argus Pod 0.7Ω 2-pack", "Pods & Coils", "Voopoo", 9.99, 4.5, stock=10, wh=100),
	_i("POD-013", "Lost Vape Ursa Pod 0.6Ω 2-pack", "Pods & Coils", "Lost Vape", 9.99, 4.5, stock=8, wh=80),
	# ---- Glass & Rigs (GLS) -----------------------------------------------------------
	_i("GLS-001", "12\" Beaker Bong — Clear, Ice Pinch", "Glass & Rigs", "CloudChaserz Glass", 59.99, 22.0, stock=4, wh=24, age=True),
	_i("GLS-002", "14\" Straight Tube Bong — Thick Glass", "Glass & Rigs", "CloudChaserz Glass", 79.99, 30.0, stock=3, wh=16, age=True),
	_i("GLS-003", "18\" Double Perc Beaker — Blue Accents", "Glass & Rigs", "CloudChaserz Glass", 129.99, 52.0, stock=2, wh=10, age=True),
	_i("GLS-004", "Mini Dab Rig 6\" — Recycler", "Glass & Rigs", "CloudChaserz Glass", 69.99, 26.0, stock=3, wh=18, age=True),
	_i("GLS-005", "Banger Hanger Rig 8\" w/ Quartz Banger", "Glass & Rigs", "CloudChaserz Glass", 89.99, 34.0, stock=3, wh=16, age=True),
	_i("GLS-006", "Hammer Bubbler — Green Swirl", "Glass & Rigs", "CloudChaserz Glass", 39.99, 14.0, stock=4, wh=24, age=True),
	_i("GLS-007", "Sherlock Bubbler — Amber", "Glass & Rigs", "CloudChaserz Glass", 44.99, 16.0, stock=4, wh=24, age=True),
	_i("GLS-008", "Spoon Hand Pipe — Fumed Color Changing", "Glass & Rigs", "CloudChaserz Glass", 19.99, 6.0, stock=10, wh=60, age=True),
	_i("GLS-009", "Chillum One-Hitter — Glass", "Glass & Rigs", "CloudChaserz Glass", 9.99, 3.0, stock=12, wh=80, age=True),
	_i("GLS-010", "Quartz Banger 14mm Male 90°", "Glass & Rigs", "CloudChaserz Glass", 19.99, 7.0, stock=8, wh=50, age=True),
	_i("GLS-011", "Glass Bowl 14mm — Colored Marble", "Glass & Rigs", "CloudChaserz Glass", 12.99, 4.0, stock=12, wh=80, age=True),
	_i("GLS-012", "Downstem 18mm→14mm 4\"", "Glass & Rigs", "CloudChaserz Glass", 14.99, 5.0, stock=8, wh=50, age=True),
	_i("GLS-013", "Silicone Bong 10\" — Unbreakable", "Glass & Rigs", "Eyce", 34.99, 13.0, stock=5, wh=30, age=True),
	_i("GLS-014", "Carb Cap — Directional Bubble", "Glass & Rigs", "CloudChaserz Glass", 14.99, 5.0, stock=8, wh=50, age=True),
	_i("GLS-015", "Dab Tool Set — Stainless 5 pc", "Glass & Rigs", "CloudChaserz Glass", 16.99, 6.0, stock=8, wh=50, age=True),
	# ---- Hookah & Shisha (HKA) --------------------------------------------------------
	_i("HKA-001", "Khalil Mamoon Classic Hookah 28\"", "Hookah & Shisha", "Khalil Mamoon", 129.99, 60.0, stock=2, wh=10),
	_i("HKA-002", "Starbuzz Carbine 2.0 Hookah", "Hookah & Shisha", "Starbuzz", 199.99, 95.0, stock=1, wh=6),
	_i("HKA-003", "Moze Breeze Pro Hookah", "Hookah & Shisha", "Moze", 149.99, 70.0, stock=2, wh=8),
	_i("HKA-004", "Al Fakher Two Apples 250g", "Hookah & Shisha", "Al Fakher", 24.99, 12.0, flavor="Two Apples", stock=10, wh=80),
	_i("HKA-005", "Al Fakher Mint 250g", "Hookah & Shisha", "Al Fakher", 24.99, 12.0, flavor="Mint", stock=10, wh=80),
	_i("HKA-006", "Al Fakher Grape with Mint 250g", "Hookah & Shisha", "Al Fakher", 24.99, 12.0, flavor="Grape with Mint", stock=8, wh=60),
	_i("HKA-007", "Al Fakher Watermelon Mint 50g", "Hookah & Shisha", "Al Fakher", 7.99, 3.5, flavor="Watermelon Mint", stock=12, wh=100),
	_i("HKA-008", "Starbuzz Blue Mist 250g", "Hookah & Shisha", "Starbuzz", 29.99, 14.0, flavor="Blue Mist", stock=8, wh=60),
	_i("HKA-009", "Starbuzz Pirate's Cave 100g", "Hookah & Shisha", "Starbuzz", 14.99, 7.0, flavor="Pirate's Cave", stock=10, wh=80),
	_i("HKA-010", "Fumari White Gummi Bear 100g", "Hookah & Shisha", "Fumari", 13.99, 6.5, flavor="White Gummi Bear", stock=10, wh=80),
	_i("HKA-011", "Tangiers Cane Mint 250g", "Hookah & Shisha", "Tangiers", 27.99, 13.0, flavor="Cane Mint", stock=6, wh=40),
	_i("HKA-012", "CocoUrth Coconut Coals 72 pc (flats)", "Hookah & Shisha", "CocoUrth", 12.99, 5.5, stock=12, wh=120, age=False),
	_i("HKA-013", "Titanium Coconut Coals 108 pc (cubes)", "Hookah & Shisha", "Titanium", 16.99, 7.5, stock=10, wh=100, age=False),
	_i("HKA-014", "Kaloud Lotus I+ Heat Management", "Hookah & Shisha", "Kaloud", 49.99, 24.0, stock=4, wh=20, age=False),
	_i("HKA-015", "Silicone Phunnel Bowl", "Hookah & Shisha", "CloudChaserz", 14.99, 5.5, stock=8, wh=50, age=False),
	_i("HKA-016", "Washable Hookah Hose 72\"", "Hookah & Shisha", "CloudChaserz", 17.99, 7.0, stock=8, wh=50, age=False),
	_i("HKA-017", "Hookah Mouth Tips 100 pc", "Hookah & Shisha", "CloudChaserz", 6.99, 2.0, stock=12, wh=120, age=False),
	# ---- Kratom (KRT) -----------------------------------------------------------------
	_i("KRT-001", "Green Maeng Da Powder 100g", "Kratom", "OPMS", 29.99, 13.0, flavor="Green Maeng Da", stock=8, wh=60),
	_i("KRT-002", "Green Maeng Da Powder 250g", "Kratom", "OPMS", 59.99, 26.0, flavor="Green Maeng Da", stock=4, wh=30),
	_i("KRT-003", "Red Bali Powder 100g", "Kratom", "OPMS", 29.99, 13.0, flavor="Red Bali", stock=8, wh=60),
	_i("KRT-004", "Red Bali Powder 250g", "Kratom", "OPMS", 59.99, 26.0, flavor="Red Bali", stock=4, wh=30),
	_i("KRT-005", "White Borneo Powder 100g", "Kratom", "OPMS", 29.99, 13.0, flavor="White Borneo", stock=6, wh=40),
	_i("KRT-006", "Gold Bali Capsules 60 ct", "Kratom", "OPMS", 34.99, 15.0, flavor="Gold Bali", stock=8, wh=60),
	_i("KRT-007", "Green Maeng Da Capsules 120 ct", "Kratom", "OPMS", 49.99, 22.0, flavor="Green Maeng Da", stock=6, wh=40),
	_i("KRT-008", "OPMS Gold Extract Capsules 5 ct", "Kratom", "OPMS", 29.99, 13.5, flavor="Gold Extract", stock=10, wh=80),
	_i("KRT-009", "MIT 45 Gold Liquid Shot", "Kratom", "MIT 45", 24.99, 11.0, flavor="Gold", stock=12, wh=100),
	_i("KRT-010", "Whole Herbs Red Vein Bali 250g", "Kratom", "Whole Herbs", 44.99, 20.0, flavor="Red Vein Bali", stock=4, wh=30),
	# ---- CBD & Hemp (CBD) -------------------------------------------------------------
	_i("CBD-001", "CBD Gummies 25mg 30 ct — Mixed Berry", "CBD & Hemp", "CBDfx", 39.99, 18.0, flavor="Mixed Berry", stock=6, wh=40, age=False),
	_i("CBD-002", "CBD Sleep Gummies 50mg CBD + 5mg Melatonin 30 ct", "CBD & Hemp", "CBDfx", 49.99, 22.0, flavor="Mixed", stock=6, wh=40, age=False),
	_i("CBD-003", "Full Spectrum CBD Tincture 1000mg 30ml", "CBD & Hemp", "Lazarus Naturals", 44.99, 20.0, ml=30, stock=6, wh=40, age=False),
	_i("CBD-004", "Full Spectrum CBD Tincture 3000mg 30ml", "CBD & Hemp", "Lazarus Naturals", 89.99, 40.0, ml=30, stock=3, wh=20, age=False),
	_i("CBD-005", "CBD Muscle Balm 1000mg", "CBD & Hemp", "Lazarus Naturals", 34.99, 15.0, stock=6, wh=40, age=False),
	_i("CBD-006", "Delta-8 Gummies 25mg 20 ct — Watermelon", "CBD & Hemp", "Koi", 29.99, 13.0, flavor="Watermelon", stock=8, wh=60, age=True),
	_i("CBD-007", "THCA Flower 3.5g — Jealousy", "CBD & Hemp", "Hemp Farm", 34.99, 15.0, flavor="Jealousy", stock=6, wh=40, age=True),
	_i("CBD-008", "CBD Pre-Roll 2-pack — Sour Space Candy", "CBD & Hemp", "Hemp Farm", 14.99, 6.0, flavor="Sour Space Candy", stock=10, wh=80, age=True),
	# ---- Rolling & Papers (ROL) -------------------------------------------------------
	_i("ROL-001", "RAW Classic 1¼ Papers", "Rolling & Papers", "RAW", 2.49, 0.9, stock=40, wh=400),
	_i("ROL-002", "RAW Classic King Size Slim Papers", "Rolling & Papers", "RAW", 2.99, 1.1, stock=40, wh=400),
	_i("ROL-003", "RAW Organic Hemp 1¼ Papers", "Rolling & Papers", "RAW", 2.99, 1.1, stock=30, wh=300),
	_i("ROL-004", "RAW Classic Pre-Rolled Cones 1¼ 6-pack", "Rolling & Papers", "RAW", 4.99, 2.0, stock=24, wh=240),
	_i("ROL-005", "RAW Original Tips", "Rolling & Papers", "RAW", 1.49, 0.5, stock=40, wh=400),
	_i("ROL-006", "Zig-Zag Orange 1¼ Papers", "Rolling & Papers", "Zig-Zag", 2.29, 0.8, stock=40, wh=400),
	_i("ROL-007", "Zig-Zag Ultra Thin King Size", "Rolling & Papers", "Zig-Zag", 2.79, 1.0, stock=30, wh=300),
	_i("ROL-008", "Elements Rice Papers 1¼", "Rolling & Papers", "Elements", 2.49, 0.9, stock=30, wh=300),
	_i("ROL-009", "OCB Premium Slim Papers + Tips", "Rolling & Papers", "OCB", 2.99, 1.1, stock=30, wh=300),
	_i("ROL-010", "Backwoods Honey Berry 5-pack", "Rolling & Papers", "Backwoods", 9.99, 6.0, flavor="Honey Berry", stock=20, wh=200),
	_i("ROL-011", "Swisher Sweets Grape 2-pack", "Rolling & Papers", "Swisher", 2.49, 1.4, flavor="Grape", stock=30, wh=300),
	_i("ROL-012", "Juicy Jay's Blueberry 1¼", "Rolling & Papers", "Juicy Jay's", 2.49, 0.9, flavor="Blueberry", stock=24, wh=240),
	# ---- Accessories (ACC) -----------------------------------------------------------
	_i("ACC-001", "Clipper Lighter — Assorted", "Accessories", "Clipper", 1.99, 0.7, stock=40, wh=400, age=False),
	_i("ACC-002", "BIC Lighter — Classic", "Accessories", "BIC", 1.79, 0.7, stock=40, wh=400, age=False),
	_i("ACC-003", "Blazer Big Shot Torch", "Accessories", "Blazer", 59.99, 30.0, stock=3, wh=20, age=False),
	_i("ACC-004", "Special Blue Butane Torch Mini", "Accessories", "Special Blue", 19.99, 8.0, stock=8, wh=60, age=False),
	_i("ACC-005", "Butane Refill 300ml 5x Refined", "Accessories", "Special Blue", 5.99, 2.2, stock=20, wh=200, age=False),
	_i("ACC-006", "Santa Cruz Shredder 4-pc Grinder — Medium", "Accessories", "Santa Cruz Shredder", 64.99, 32.0, stock=3, wh=16, age=False),
	_i("ACC-007", "Aluminum 4-pc Grinder 2.5\"", "Accessories", "CloudChaserz", 19.99, 7.0, stock=10, wh=80, age=False),
	_i("ACC-008", "Formula 420 Glass Cleaner 12oz", "Accessories", "Formula 420", 9.99, 4.0, stock=10, wh=80, age=False),
	_i("ACC-009", "Boveda 62% 8g 4-pack", "Accessories", "Boveda", 6.99, 3.0, stock=12, wh=100, age=False),
	_i("ACC-010", "Stash Jar — UV Glass 250ml", "Accessories", "CloudChaserz", 14.99, 5.5, stock=8, wh=60, age=False),
	_i("ACC-011", "Rolling Tray — Medium Metal", "Accessories", "RAW", 8.99, 3.5, stock=12, wh=100, age=False),
	_i("ACC-012", "Smell-Proof Bag 7\"", "Accessories", "CloudChaserz", 12.99, 4.5, stock=10, wh=80, age=False),
	_i("ACC-013", "18650 Battery 3000mAh 2-pack", "Accessories", "Molicel", 19.99, 9.0, stock=8, wh=60, age=False),
	_i("ACC-014", "Dual Bay 18650 Charger", "Accessories", "Nitecore", 24.99, 11.0, stock=5, wh=30, age=False),
	_i("ACC-015", "USB-C Cable 3ft", "Accessories", "CloudChaserz", 6.99, 2.0, stock=15, wh=120, age=False),
	_i("ACC-016", "CloudChaserz Logo Tee", "Accessories", "CloudChaserz", 24.99, 8.0, stock=6, wh=40, age=False),
	_i("ACC-017", "CloudChaserz Snapback Cap", "Accessories", "CloudChaserz", 29.99, 9.0, stock=4, wh=30, age=False),
	# ---- Services / Gift Card (SVC) ---------------------------------------------------
	_i("SVC-001", "Gift Card $25", "Services", "CloudChaserz", 25.0, 0, stock=0, wh=0, age=False),
	_i("SVC-002", "Gift Card $50", "Services", "CloudChaserz", 50.0, 0, stock=0, wh=0, age=False),
	_i("SVC-003", "Gift Card $100", "Services", "CloudChaserz", 100.0, 0, stock=0, wh=0, age=False),
	_i("SVC-004", "Coil Install & Prime", "Services", "CloudChaserz", 5.0, 0, stock=0, wh=0, age=False),
	_i("SVC-005", "Hookah Setup Service", "Services", "CloudChaserz", 15.0, 0, stock=0, wh=0, age=False),
]

ITEM_META: dict[str, dict[str, Any]] = {i["code"]: i for i in ITEMS}

# stock flavour per region: Houston sells more glass/hookah, Tulsa metro more disposables
STORE_STOCK_FACTOR: dict[str, float] = {"HOU-MTR": 1.6, "OK-BIX": 1.3, "OK-MINGO": 1.3, "OK-BA": 1.2, "OK-OWA": 1.1, "OK-JENKS": 1.0, "OK-STUL": 1.0, "OK-ETUL": 0.9, "OK-SAP": 0.8, "OK-MUS": 0.8, "OK-YALE": 0.8}


def legacy_item_tuples() -> list[tuple]:
	"""Shape of ``setup.demo.ITEMS`` (used by ``restore_demo_prices`` and a few helpers)."""
	return [(i["code"], i["name"], i["group"], i["department"], i["brand"], 0, i["flavor"], i["rate"], i["code"] in SERIALIZED, i["stock"]) for i in ITEMS]


# ---------------------------------------------------------------------------
def ensure_item_groups() -> None:
	root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ("in", ("", None))}, "name") or "All Item Groups"
	for g in ITEM_GROUPS:
		if not frappe.db.exists("Item Group", g):
			frappe.get_doc({"doctype": "Item Group", "item_group_name": g, "parent_item_group": root, "is_group": 0}).insert(ignore_permissions=True)


def _item_values(i: dict[str, Any]) -> dict[str, Any]:
	return {
		"maison_department": i["department"],
		"maison_brand": i["brand"],
		"maison_flavor": i["flavor"],
		"maison_nicotine_mg": flt(i["nic"]),
		"maison_volume_ml": flt(i["ml"]),
		"maison_puffs": int(i["puffs"]),
		"maison_age_restricted": 1 if i["age"] else 0,
		"maison_msrp": flt(i["msrp"]),
		"maison_taxable": 1,
	}


def ensure_items() -> int:
	from maison_pos.setup.cloudchaserz import stores
	from maison_pos.setup.demo import ensure_item_barcode

	created = 0
	default_wh = stores.warehouse_name(stores.WAREHOUSE_CODE)
	for i in ITEMS:
		code = i["code"]
		is_stock = i["group"] != "Services"
		if not frappe.db.exists("Item", code):
			doc = frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": code,
					"item_name": i["name"],
					"item_group": i["group"],
					"stock_uom": "Nos",
					"is_stock_item": 1 if is_stock else 0,
					"is_sales_item": 1,
					"has_serial_no": 1 if code in SERIALIZED else 0,
					"include_item_in_manufacturing": 0,
					"description": i["name"],
					"standard_rate": i["rate"],
					"valuation_rate": i["cost"] if is_stock else 0,
					"maison_barcode": ean13_for(code),
					"barcodes": [{"barcode": ean13_for(code), "barcode_type": "EAN"}],
					"item_defaults": [{"company": COMPANY, "default_warehouse": default_wh}],
					"weight_per_unit": 0.12 if i["group"] in ("Disposables", "E-Liquid", "Pods & Coils", "Rolling & Papers") else 0.6,
					"weight_uom": "Kg" if frappe.db.exists("UOM", "Kg") else None,
					**_item_values(i),
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_if_duplicate=True)
			created += 1
		else:
			# keep the vertical attributes current (idempotent re-runs after a migrate)
			current = frappe.db.get_value("Item", code, list(_item_values(i)), as_dict=True) or {}
			diff = {k: v for k, v in _item_values(i).items() if (current.get(k) or 0) != (v or 0) and (current.get(k) or "") != (v or "")}
			if diff:
				frappe.db.set_value("Item", code, diff, update_modified=False)
		ensure_item_barcode(code)
		if not frappe.db.exists("Item Price", {"item_code": code, "price_list": PRICE_LIST, "selling": 1}):
			frappe.get_doc({"doctype": "Item Price", "item_code": code, "price_list": PRICE_LIST, "price_list_rate": i["rate"], "selling": 1, "currency": CURRENCY}).insert(ignore_permissions=True)
	frappe.clear_cache(doctype="Item")
	return created


def ensure_stock() -> list[str]:
	"""Opening stock per store (scaled by STORE_STOCK_FACTOR) + the main warehouse, back-dated 7 days."""
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import stores

	posting_date, posting_time = demo.demo_stock_posting()
	entries: list[str] = []
	targets = [(s["code"], stores.warehouse_name(s["code"]), STORE_STOCK_FACTOR.get(s["code"], 1.0), "stock") for s in stores.STORES]
	targets.append((stores.WAREHOUSE_CODE, stores.warehouse_name(stores.WAREHOUSE_CODE), 1.0, "wh"))
	for code, warehouse, factor, key in targets:
		rows = []
		for i in ITEMS:
			if i["group"] == "Services" or i[key] <= 0:
				continue
			if flt(frappe.db.get_value("Bin", {"item_code": i["code"], "warehouse": warehouse}, "actual_qty")) > 0:
				continue
			qty = max(1, int(round(i[key] * factor)))
			rows.append({"item_code": i["code"], "qty": qty, "t_warehouse": warehouse, "basic_rate": i["cost"], "allow_zero_valuation_rate": 0})
		if not rows:
			continue
		se = demo._stock_entry_doc(warehouse, rows, posting_date, posting_time)
		se.remarks = f"{DEMO_STOCK_REMARK} {code}"
		se.insert()
		se.submit()
		entries.append(se.name)
	return entries


def restore_prices() -> int:
	restored = 0
	if not frappe.db.exists("Price List", PRICE_LIST):
		return 0
	for i in ITEMS:
		if frappe.db.exists("Item", i["code"]) and not frappe.db.exists("Item Price", {"item_code": i["code"], "price_list": PRICE_LIST, "selling": 1}):
			frappe.get_doc({"doctype": "Item Price", "item_code": i["code"], "price_list": PRICE_LIST, "price_list_rate": i["rate"], "selling": 1, "currency": CURRENCY}).insert(ignore_permissions=True)
			restored += 1
	return restored


# ---------------------------------------------------------------------------
# webshop: publish the catalogue with generated art
# ---------------------------------------------------------------------------
WEB_GROUPS = ("Disposables", "E-Liquid", "Devices & Mods", "Pods & Coils", "Glass & Rigs", "Hookah & Shisha", "Kratom", "CBD & Hemp", "Rolling & Papers", "Accessories")
FEATURED = ["DSP-001", "DEV-003", "GLS-003", "HKA-002", "DSP-008", "DEV-008", "KRT-001", "CBD-003"]
SHORT_DESCRIPTIONS = {
	"Disposables": "Pre-filled, rechargeable disposable vape. 21+ only, sold in store.",
	"E-Liquid": "Bottled e-liquid in freebase and nicotine-salt strengths. 21+ only, sold in store.",
	"Devices & Mods": "Pod systems, mods and 510 batteries from the brands we trust.",
	"Pods & Coils": "Replacement pods and coils — ask us to install and prime them.",
	"Glass & Rigs": "Hand-picked glass. Bring it back to the store for a free clean.",
	"Hookah & Shisha": "Hookahs, shisha, coals and heat management.",
	"Kratom": "Lab-tested kratom powders, capsules and shots. 21+ only, sold in store.",
	"CBD & Hemp": "Hemp-derived CBD, Delta-8 and THCA products.",
	"Rolling & Papers": "Papers, cones, tips and cigarillos.",
	"Accessories": "Lighters, torches, grinders, cleaners and CloudChaserz merch.",
}


def _write_svg(file_doc, svg: str) -> None:
	"""Replace a File's bytes in place — the URL keeps working.

	v0.6 R — deleting and re-inserting the File would hand out a new, hashed URL and leave every
	copy of the old one (``Website Item.website_image``, cached catalogue snapshots) pointing at the
	stale drawing. Rewriting the bytes under the same name updates every surface at once.
	"""
	import hashlib

	blob = svg.encode("utf-8")
	with open(file_doc.get_full_path(), "wb") as fh:
		fh.write(blob)
	frappe.db.set_value("File", file_doc.name, {"file_size": len(blob), "content_hash": hashlib.md5(blob).hexdigest()}, update_modified=False)


def _redraw_visuals(item, svg: str) -> int:
	"""Rewrite every generated SVG this item is shown through (Item.image + Website Item)."""
	urls = {item.image}
	if frappe.db.exists("DocType", "Website Item"):
		wi = frappe.db.get_value("Website Item", {"item_code": item.item_code}, ["website_image", "thumbnail"], as_dict=True)
		if wi:
			urls |= {wi.get("website_image"), wi.get("thumbnail")}
	n = 0
	for url in {u for u in urls if u and str(u).endswith(".svg")}:
		name = frappe.db.get_value("File", {"file_url": url}, "name")
		if not name:
			continue
		_write_svg(frappe.get_doc("File", name), svg)
		n += 1
	return n


def _attach_visual(item) -> Optional[str]:
	file_name = f"cloudchaserz-{item.item_code.lower()}.svg"
	existing = frappe.db.get_value("File", {"attached_to_doctype": "Item", "attached_to_name": item.item_code, "file_name": file_name}, "file_url")
	if existing:
		return existing
	svg = _item_svg(item)
	f = frappe.get_doc({"doctype": "File", "file_name": file_name, "attached_to_doctype": "Item", "attached_to_name": item.item_code, "attached_to_field": "image", "is_private": 0, "content": svg})
	f.flags.ignore_permissions = True
	f.insert()
	return f.file_url


def _item_svg(item) -> str:
	from maison_pos.setup.cloudchaserz.art import product_svg

	meta = ITEM_META.get(item.item_code, {})
	return product_svg(item.item_code, item.item_name, item.item_group, meta.get("brand"), meta.get("flavor"))


def ensure_images(redraw: bool = False) -> int:
	"""Generated SVG art on every item (also used by the POS tiles and the shop).

	``redraw=1`` re-renders art that already exists, in place, so a change to the drawing itself
	reaches a site that is already seeded (v0.6 R dropped the caption burned into every picture)::

	    bench --site <site> execute maison_pos.setup.cloudchaserz.catalog.ensure_images \\
	        --kwargs "{'redraw': 1}"
	"""
	n = 0
	for i in ITEMS:
		if not frappe.db.exists("Item", i["code"]):
			continue
		item = frappe.get_doc("Item", i["code"])
		if item.image:
			if redraw and _redraw_visuals(item, _item_svg(item)):
				n += 1
			continue
		url = _attach_visual(item)
		if url:
			frappe.db.set_value("Item", item.name, "image", url, update_modified=False)
			n += 1
	return n


def seed_webshop() -> dict[str, Any]:
	"""Publish the catalogue on the Frappe Webshop (no-op when the app is missing)."""
	ensure_images()
	from maison_pos.webshop import is_webshop_installed

	if not is_webshop_installed():
		return {"skipped": "webshop not installed"}
	from maison_pos.setup import demo_v04_webshop as web

	saved = (web.COMPANY, web.ABBR, web.WEB_USER, web.WEB_USER_CUSTOMER, web.DEMO_PASSWORD)
	web.COMPANY, web.ABBR = COMPANY, ABBR
	web.WEB_USER, web.WEB_USER_CUSTOMER, web.DEMO_PASSWORD = WEB_SHOPPER, WEB_SHOPPER_CUSTOMER, DEMO_PASSWORD
	web_user = None
	try:
		web.create_webshop_custom_fields()
		web.ensure_web_mode_of_payment_account()
		gateway_account = web.ensure_payment_gateway()
		web.ensure_webshop_settings(gateway_account)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "cloudchaserz webshop settings")
		gateway_account = None
	try:
		# --- v0.8 QA A1 — the shop could not take an order from a new customer ---
		# `Website Settings.disable_signup = 1`, no `Portal Settings.default_role` and not one
		# Website User: `/cart` and `/shop/checkout` both redirect to a `/login` that offered no
		# way to register. The AWANZ seed has always created a shopper and set the portal role
		# (`demo_v04_webshop.ensure_web_user`); this seed simply never called it.
		from maison_pos.webshop.setup import ensure_portal_signup

		ensure_portal_signup()
		_ensure_web_shopper_customer()
		web_user = web.ensure_web_user()
		# --- end v0.8 QA A1 ---
	except Exception:
		# a missing payment gateway must not cost the storefront its sign-up (v0.8 QA A1)
		frappe.log_error(frappe.get_traceback(), "cloudchaserz webshop shopper")
	finally:
		web.COMPANY, web.ABBR, web.WEB_USER, web.WEB_USER_CUSTOMER, web.DEMO_PASSWORD = saved
	for group in WEB_GROUPS:
		if frappe.db.exists("Item Group", group):
			doc = frappe.get_doc("Item Group", group)
			if not doc.show_in_website:
				doc.show_in_website = 1
				doc.flags.ignore_permissions = True
				doc.save()
	published = 0
	try:
		from webshop.webshop.doctype.website_item.website_item import make_website_item

		root = frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 1, "parent_warehouse": ("in", ("", None))}, "name")
		for i in ITEMS:
			if i["group"] not in WEB_GROUPS or not frappe.db.exists("Item", i["code"]):
				continue
			item = frappe.get_doc("Item", i["code"])
			if frappe.db.get_value("Item", item.name, "maison_web_mode") != "Buy":
				frappe.db.set_value("Item", item.name, "maison_web_mode", "Buy", update_modified=False)
			name = frappe.db.get_value("Website Item", {"item_code": item.item_code}, "name")
			if not name:
				wi = make_website_item(item.as_dict(), save=False)
				wi.website_warehouse = root
				wi.published = 1
				wi.website_image = item.image
				wi.short_description = SHORT_DESCRIPTIONS.get(item.item_group, "")
				wi.ranking = (len(FEATURED) - FEATURED.index(item.item_code)) * 10 if item.item_code in FEATURED else 0
				wi.flags.ignore_permissions = True
				wi.insert()
			published += 1
		try:
			ws = frappe.get_doc("Website Settings")
			changed = False
			if ws.home_page != "shop":
				ws.home_page = "shop"
				changed = True
			if ws.app_name != "CloudChaserz":
				ws.app_name = "CloudChaserz"
				changed = True
			if changed:
				ws.flags.ignore_permissions = True
				ws.save()
		except Exception:
			frappe.log_error(frappe.get_traceback(), "cloudchaserz website settings")
	except Exception:
		frappe.log_error(frappe.get_traceback(), "cloudchaserz website items")
	frappe.clear_cache(doctype="Webshop Settings")
	return {"published": published, "gateway_account": gateway_account, "web_user": web_user, "signup_enabled": not cint(frappe.db.get_single_value("Website Settings", "disable_signup"))}


# --- v0.8 QA A1 — the demo shopper the storefront signs in as ---
WEB_SHOPPER = "shopper@cloudchaserz.example"
WEB_SHOPPER_CUSTOMER = "Jordan Vance"
WEB_SHOPPER_MOBILE = "+1 918 555 0180"


def _ensure_web_shopper_customer() -> str:
	"""The Customer behind the demo web shopper (a rewards member, like any online client)."""
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import LOYALTY_PROGRAM
	from maison_pos.setup.cloudchaserz.users import ensure_profile

	customer = demo.ensure_customer(WEB_SHOPPER_CUSTOMER, WEB_SHOPPER_MOBILE, WEB_SHOPPER)
	if frappe.db.exists("Loyalty Program", LOYALTY_PROGRAM) and frappe.db.get_value("Customer", customer, "loyalty_program") != LOYALTY_PROGRAM:
		frappe.db.set_value("Customer", customer, "loyalty_program", LOYALTY_PROGRAM, update_modified=False)
	ensure_profile(customer, "1992-09-12", "OK-BA")
	demo.ensure_client_numbers()
	return customer
# --- end v0.8 QA A1 ---
