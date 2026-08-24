#!/usr/bin/env python3
"""Build the AWANZ POS system flowcharts as standalone SVG pages (Letter landscape).

Four figures:
  1  System map            — devices, cloud platform, head office / warehouse, public web
  2  A sale                — counter to books, including the offline queue and the sync
  3  Money back, stock in  — return / exchange, and replenishment request -> ship -> receive
  4  Online and rewards    — web order -> click & collect, and rewards accrual / redemption

Every label is drawn from the source of truth (docs/*.md, maison_pos/*, e2e/qa/final-acceptance.md).
"""
from __future__ import annotations

import html
import os

W, H = 792.0, 612.0  # US Letter, landscape, in points

INK = "#141410"
MUTED = "#6B675C"
FAINT = "#8C877A"
RULE = "#CFC9BA"
PANEL = "#FBF9F4"
BAND = "#F1ECE0"
WHITE = "#FFFFFF"
GOLD = "#8F7118"
GOLD_LINE = "#A98A2C"
GOLD_SOFT = "#F3E9CC"
GATE = "#A32B1F"
GATE_SOFT = "#F9E6E2"

UNB = "Unbounded, 'DejaVu Sans', sans-serif"
JOST = "Jost, 'DejaVu Sans', sans-serif"


# ---------------------------------------------------------------- primitives
def esc(s: str) -> str:
    return html.escape(str(s), quote=False)


def txt(x, y, s, size=8.0, fill=INK, weight=400, anchor="start", family=JOST, ls=None, op=None):
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    w = f' font-weight="{weight}"' if weight != 400 else ""
    l = f' letter-spacing="{ls}"' if ls else ""
    o = f' opacity="{op}"' if op else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}"'
            f' fill="{fill}"{w}{a}{l}{o}>{esc(s)}</text>')


def lines(x, y, items, size=6.8, fill=MUTED, lh=8.4, weight=400, anchor="start", family=JOST):
    return "".join(txt(x, y + i * lh, s, size, fill, weight, anchor, family) for i, s in enumerate(items))


def rect(x, y, w, h, fill=WHITE, stroke=RULE, sw=0.7, rx=3.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill}"{st}{d}/>'


def hline(x1, x2, y, stroke=RULE, sw=0.7, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x2:.1f}" y2="{y:.1f}" stroke="{stroke}" stroke-width="{sw}"{d}/>'


def vline(x, y1, y2, stroke=RULE, sw=0.7, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2:.1f}" stroke="{stroke}" stroke-width="{sw}"{d}/>'


def head(x, y, direction, color=GOLD_LINE, s=4.2):
    """Solid triangular arrowhead with its tip at (x, y)."""
    if direction == "right":
        p = f"{x:.1f},{y:.1f} {x-s*1.9:.1f},{y-s:.1f} {x-s*1.9:.1f},{y+s:.1f}"
    elif direction == "left":
        p = f"{x:.1f},{y:.1f} {x+s*1.9:.1f},{y-s:.1f} {x+s*1.9:.1f},{y+s:.1f}"
    elif direction == "down":
        p = f"{x:.1f},{y:.1f} {x-s:.1f},{y-s*1.9:.1f} {x+s:.1f},{y-s*1.9:.1f}"
    else:  # up
        p = f"{x:.1f},{y:.1f} {x-s:.1f},{y+s*1.9:.1f} {x+s:.1f},{y+s*1.9:.1f}"
    return f'<polygon points="{p}" fill="{color}"/>'


def harrow(x1, x2, y, color=GOLD_LINE, sw=1.3, direction="right", dash=None, both=False):
    """Horizontal arrow from x1 to x2 (x1 < x2); `direction` says which end carries the head."""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    out = [f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x2:.1f}" y2="{y:.1f}" stroke="{color}" stroke-width="{sw}"{d}/>']
    if both:
        out += [head(x2, y, "right", color), head(x1, y, "left", color)]
    elif direction == "right":
        out.append(head(x2, y, "right", color))
    else:
        out.append(head(x1, y, "left", color))
    return "".join(out)


def varrow(x, y1, y2, color=GOLD_LINE, sw=1.3, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="{sw}"{d}/>'
            + head(x, y2, "down" if y2 > y1 else "up", color))


def wrap(s: str, n: int) -> list[str]:
    words, out, cur = s.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if len(t) <= n:
            cur = t
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


# ------------------------------------------------------------------ chrome
def page_open():
    return [f'<rect x="0" y="0" width="{W}" height="{H}" fill="{WHITE}"/>']


def title_block(o, title, subtitle, fignum):
    o.append(f'<rect x="0" y="0" width="{W}" height="5" fill="{GOLD}"/>')
    o.append(txt(32, 36, title, 15, INK, 700, family=UNB))
    o.append(txt(32, 51, subtitle, 8.2, MUTED))
    o.append(txt(760, 36, f"FIGURE {fignum}", 8.5, GOLD, 700, anchor="end", family=UNB, ls="1"))
    o.append(txt(760, 51, "cloudchaserz.frappe.cloud", 7.6, FAINT, anchor="end"))
    o.append(hline(32, 760, 60, RULE, 0.9))


def footer(o, caption):
    o.append(hline(32, 760, 566, RULE, 0.7))
    o.append(txt(32, 581, "AWANZ POS by CloudChaserz  ·  Powered by Futonix.com", 7.2, FAINT))
    o.append(txt(760, 581, caption, 7.2, FAINT, anchor="end"))


def svg(body: list[str], label: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" width="{W:.0f}pt"'
            f' height="{H:.0f}pt" role="img" aria-label="{esc(label)}">\n' + "\n".join(body) + "\n</svg>\n")


# ------------------------------------------------------------ shared pieces
def panel(o, x, y, w, h, heading, sub=None, accent=RULE, sw=0.8, fill=PANEL):
    o.append(rect(x, y, w, h, fill, accent, sw, rx=7))
    o.append(txt(x + 10, y + 17, heading, 8.4, INK if accent == RULE else accent, 700, family=UNB))
    if sub:
        o.append(txt(x + 10, y + 28, sub, 6.9, FAINT))


def card(o, x, y, w, h, title, body, tcol=INK, fill=WHITE, stroke=RULE, tsize=7.6, bsize=6.6, chars=None):
    o.append(rect(x, y, w, h, fill, stroke, 0.7, rx=3.5))
    o.append(txt(x + 7, y + 13, title, tsize, tcol, 600))
    if body:
        chars = chars or int((w - 14) / (bsize * 0.475))
        rows = []
        for para in body:
            rows += wrap(para, chars)
        o.append(lines(x + 7, y + 24, rows, bsize, MUTED, 8.0))


def stepbox(o, x, y, w, h, n, title, body, kind="normal"):
    fill, stroke, tcol = WHITE, RULE, INK
    if kind == "gate":
        fill, stroke, tcol = GATE_SOFT, GATE, GATE
    elif kind == "cloud":
        fill, stroke, tcol = GOLD_SOFT, GOLD_LINE, GOLD
    o.append(rect(x, y, w, h, fill, stroke, 0.9, rx=4))
    o.append(f'<circle cx="{x+11:.1f}" cy="{y+12:.1f}" r="7" fill="{tcol}"/>')
    o.append(txt(x + 11, y + 14.6, str(n), 7.2, WHITE, 700, anchor="middle"))
    o.append(lines(x + 22, y + 14.6, wrap(title, int((w - 28) / 3.7)), 7.3, tcol, 8.6, 600))
    if body:
        rows = []
        for para in body:
            rows += wrap(para, int((w - 14) / 3.15))
        o.append(lines(x + 7, y + 34, rows, 6.5, MUTED, 7.9))


def flow_row(o, x0, y, w_total, steps, gap=9.0, h=74, arrow_y=None):
    """Lay `steps` (list of dicts) across w_total with connecting arrows."""
    n = len(steps)
    bw = (w_total - gap * (n - 1)) / n
    ay = arrow_y if arrow_y is not None else y + h / 2
    for i, s in enumerate(steps):
        x = x0 + i * (bw + gap)
        stepbox(o, x, y, bw, h, i + 1, s["t"], s.get("b"), s.get("k", "normal"))
        if i < n - 1:
            o.append(harrow(x + bw + 1.5, x + bw + gap - 1.5, ay, GOLD_LINE, 1.2))
    return bw


def actor_tag(o, x, y, w, label, sub=None):
    o.append(rect(x, y, w, 34 if sub else 22, BAND, None, rx=3))
    o.append(txt(x + 8, y + 14, label, 7.4, INK, 700, family=UNB))
    if sub:
        o.append(txt(x + 8, y + 26, sub, 6.5, MUTED))


def legend(o, x, y, items):
    cx = x
    for kind, label in items:
        col = {"gold": GOLD_LINE, "gate": GATE, "rule": FAINT}[kind]
        fill = {"gold": GOLD_SOFT, "gate": GATE_SOFT, "rule": WHITE}[kind]
        o.append(rect(cx, y - 6.5, 9, 9, fill, col, 0.9, rx=2))
        o.append(txt(cx + 13, y + 1, label, 6.6, MUTED))
        cx += 13 + len(label) * 3.1 + 16


# =============================================================== FIGURE 1
def figure1() -> str:
    o = page_open()
    title_block(o, "How AWANZ POS fits together",
                "One cloud site  ·  11 stores  ·  the Houston head office and main warehouse  ·  the public storefront",
                1)

    LX, LW = 32, 194
    MX, MW = 316, 184
    RX, RW = 590, 170
    LCH = (226 + 316) / 2      # left↔middle channel centre
    RCH = (500 + 590) / 2      # middle↔right channel centre

    # ---- middle: the platform ------------------------------------------
    panel(o, MX, 76, MW, 464, "THE CLOUD PLATFORM", "cloudchaserz.frappe.cloud — one Frappe site", GOLD, 1.4, GOLD_SOFT)
    bx, bw = MX + 10, MW - 20
    card(o, bx, 116, bw, 32, "AWANZ POS app",
         ["Frappe v15 + ERPNext v15, with HRMS, CRM, Webshop and Payments"])
    card(o, bx, 154, bw, 60, "API  ·  maison_pos.api.*",
         ["catalog.bootstrap · sales.submit_batch · returns · inventory · shipping · rewards · webshop · salon · dashboard · reports"])
    card(o, bx, 220, bw, 62, "The books it writes",
         ["Sales Invoice · Stock Ledger · Loyalty Point Entry · AWANZ Shipment · AWANZ Age Check · Commission Entry"])
    card(o, bx, 288, bw, 40, "Realtime  ·  socket.io",
         ["awanz_sale is published on every submitted invoice"])
    card(o, bx, 334, bw, 56, "Scheduler",
         ["product trends every 15 min · low-stock scan hourly · birthday coupons + tracking daily · insights weekly"])
    card(o, bx, 396, bw, 62, "Store scoping  ·  scoping.py",
         ["every endpoint checks the caller's store; another store's data answers 403 — over the API, in list views and on the document"],
         tcol=GATE, stroke=GATE, fill=GATE_SOFT)
    o.append(lines(bx, 476, wrap("One site, one brand. Every screen — till, client display, wall, storefront, receipt "
                                 "— reads its wordmark, product name and rewards copy from AWANZ POS Settings.", 46),
                   6.7, MUTED, 8.4))

    # ---- left: the store ------------------------------------------------
    panel(o, LX, 76, LW, 304, "IN EVERY STORE   (× 11)", "one till, one client display, one card reader", RULE, 0.9)
    dx, dw = LX + 10, LW - 20
    card(o, dx, 110, dw, 42, "Till — iPad or iPhone",
         ["/pos — offline-first PWA; catalogue, prices and tax cached in IndexedDB"])
    card(o, dx, 158, dw, 42, "Client display — iPad mini",
         ["/salon — paired to the till with a 6-digit code; mirrors the basket (2 s poll + socket)"])
    card(o, dx, 206, dw, 34, "Card reader — Verifone V660p",
         ["Stripe Terminal; prints the receipt on its own 58 mm head"])
    card(o, dx, 244, dw, 34, "Receipt printer — Epson TM-m30III",
         ["80 mm ePOS over the store LAN (printer_ip)"])
    card(o, dx, 282, dw, 34, "Scanner — Bluetooth HID or camera",
         ["EAN-13 items · Code-128 serials · QR receipts, client cards and coupons"])
    card(o, dx, 320, dw, 52, "21+ AGE GATE  —  runs on the device",
         ["scan the PDF417 on the licence or key the date of birth. Under-age and expired IDs are refused "
          "before the item reaches the basket. Only the outcome is stored."],
         tcol=GATE, stroke=GATE, fill=GATE_SOFT)

    # ---- left bottom: the public web ------------------------------------
    panel(o, LX, 394, LW, 146, "THE CUSTOMER, ONLINE", None, RULE, 0.9)
    card(o, dx, 414, dw, 40, "/shop  —  storefront",
         ["bag, checkout, click & collect at a chosen store. 21+ items are not sold online — 'Available in store'."])
    card(o, dx, 458, dw, 34, "/rewards  —  the programme",
         ["$1 = 1 point; the join form is the same one the till and the client display use"])
    card(o, dx, 496, dw, 40, "/r/<token>  —  public receipt",
         ["opened from the QR on the printed receipt: lines, points, balance and private 1–5 feedback"])

    # ---- right: Houston --------------------------------------------------
    panel(o, RX, 76, RW, 464, "HOUSTON", "head office + main warehouse  ·  HOU-WH", RULE, 0.9)
    rx_, rw_ = RX + 10, RW - 20
    card(o, rx_, 112, rw_, 54, "/awanz-dashboard  —  Command",
         ["Live · Stores · Products · Clients · Insights · Reports. Head Office and Regional only."])
    card(o, rx_, 170, rw_, 52, "/warehouse  —  warehouse desk",
         ["approve or reject replenishment, pick, pack, buy the cheapest label, ship"])
    card(o, rx_, 226, rw_, 56, "/warehouse-wall  —  the 55-inch board",
         ["five kanban columns with age timers; auto-prints the packing list and the label"])
    card(o, rx_, 286, rw_, 52, "/app  —  admin desk",
         ["price approvals, campaigns and coupons, report CSV, settings. Head office only."])
    card(o, rx_, 342, rw_, 52, "HOU-WH  —  main warehouse stock",
         ["the only warehouse that ships to stores; it never sells"])
    o.append(lines(rx_, 410, wrap("A store manager sees their own store and nothing else. The warehouse admin sees "
                                  "every store's supply documents and cannot sell. Regional reads its region; "
                                  "head office reads the chain.", 40), 6.7, MUTED, 8.4))

    # ---- channel arrows: store ↔ cloud -----------------------------------
    def chan(cx, y, direction, label, sub, dash=None, halfw=44):
        o.append(harrow(cx - halfw, cx + halfw, y, GOLD_LINE, 1.3, direction, dash))
        ltop = wrap(label, 22)
        o.append(lines(cx, y - 10 - (len(ltop) - 1) * 7.6, ltop, 6.6, INK, 7.6, 600, "middle"))
        if sub:
            o.append(lines(cx, y + 12, wrap(sub, 24), 6.2, MUTED, 7.2, 400, "middle"))

    chan(LCH, 128, "left", "catalog.bootstrap", "catalogue, prices, tax, reward tiers, readers, brand")
    chan(LCH, 200, "right", "sales.submit_batch", "one sale — or the whole offline queue, de-duplicated on its uuid")
    chan(LCH, 272, "right", "returns · inventory · hr", "credit notes, counts, receipts, clock-in / clock-out")
    chan(LCH, 344, "left", "Stock Entry", "HOU-WH → <store> In Transit → <store>: the delivery the manager scans in")
    chan(LCH, 452, "right", "Sales Order (web)", "maison_web_order = 1 → the store's Web orders queue")

    chan(RCH, 128, "right", "awanz_sale over socket.io", "the right store card pulses in under a second")
    chan(RCH, 210, "right", "dashboard · reports · insights", "aggregates, trends, churn, CSV export")
    chan(RCH, 300, "left", "shipping.approve → pick → pack → buy → ship", "raises the AWANZ Shipment and both stock legs")
    chan(RCH, 400, "left", "price approval · campaigns · coupons", "an approved price becomes a Pricing Rule on that store's warehouse only")

    legend(o, 32, 552, [("gold", "the AWANZ platform and its data path"),
                        ("gate", "a gate: approval, or a check that can refuse"),
                        ("rule", "a device, a screen or a document")])
    footer(o, "Figure 1 — System map")
    return svg(o, "System map of AWANZ POS by CloudChaserz: eleven stores with till, client display, card "
                  "reader, printer and scanner talk to one Frappe cloud site, which feeds the Houston head "
                  "office dashboard and warehouse desk and serves the public storefront and rewards page.")


# =============================================================== FIGURE 2
def figure2() -> str:
    o = page_open()
    title_block(o, "A sale — from the counter to the books",
                "What the till does, what the cloud writes, what head office sees — and what changes when the network drops",
                2)

    x0, wtot = 148, 612

    # lane 1 — the counter
    actor_tag(o, 32, 76, 108, "AT THE COUNTER", "associate + customer")
    flow_row(o, x0, 76, wtot, [
        {"t": "Open the till", "b": ["/pos → pick the store → tap your name → 4-digit PIN. The catalogue loads (160 items)."]},
        {"t": "Ring the items", "b": ["tap a tile, search, or scan the EAN-13. Line discount and qty on the basket."]},
        {"t": "21+ item? CHECK ID", "b": ["scan the PDF417 on the licence, or key the DOB. Under-age or expired: refused."], "k": "gate"},
        {"t": "Attach the member", "b": ["client no. MC###### or phone on the keypad, or scan their QR. Points show live."]},
        {"t": "Offer a reward", "b": ["Redeem shows only the tiers they can afford: $5/100, $10/200, $15/300."]},
        {"t": "Take the money", "b": ["Cash, Card on the V660p, or Split — cash part then card part."]},
        {"t": "Receipt", "b": ["prints on the reader or the 80 mm printer; QR opens /r/<token>. E-mail it from the same screen."]},
    ], gap=9, h=86, arrow_y=119)

    # lane 2 — the cloud
    actor_tag(o, 32, 184, 108, "THE CLOUD", "cloudchaserz.frappe.cloud")
    o.append(rect(x0, 184, wtot, 84, GOLD_SOFT, GOLD_LINE, 1.0, rx=5))
    cw = (wtot - 30) / 4
    for i, (t, b) in enumerate([
        ("sales.submit_batch", "one POST carries the sale. Idempotent on maison_offline_uuid — the same sale can never post twice."),
        ("Sales Invoice", "is_pos, update_stock: stock leaves the store's warehouse, the tender rows are written, tax is booked."),
        ("Loyalty + commission", "the accrual is re-priced onto net_total ($1 = 1 point before tax); a Commission Entry is written per line."),
        ("AWANZ Age Check", "outcome, method, two initials, issuing state — linked to the invoice. No name, no licence number, no DOB."),
    ]):
        cx = x0 + 10 + i * (cw + 5)
        o.append(rect(cx, 194, cw - 6, 64, WHITE, GOLD_LINE, 0.7, rx=3.5))
        o.append(txt(cx + 7, 208, t, 7.4, GOLD, 600))
        o.append(lines(cx + 7, 220, wrap(b, int((cw - 20) / 3.15)), 6.5, MUTED, 7.9))
        if i < 3:
            o.append(harrow(cx + cw - 5, cx + cw + 3, 226, GOLD_LINE, 1.1))
    o.append(varrow(x0 + 60, 168, 182, GOLD_LINE, 1.3))
    o.append(txt(x0 + 66, 178, "the till submits", 6.4, MUTED))

    # lane 3 — head office
    actor_tag(o, 32, 286, 108, "HEAD OFFICE", "/awanz-dashboard")
    o.append(rect(x0, 286, wtot, 44, PANEL, RULE, 0.8, rx=5))
    for i, (t, b) in enumerate([
        ("awanz_sale is published", "the store's Live card pulses and the chain ticker moves — measured at 819 ms on the live site"),
        ("folded into today's totals", "net, tickets, avg ticket, card/cash, vs last week — one O(1) fold, full reconcile every 60 s"),
        ("and into the reports", "Daily Sales, Sales Tax Summary, Sales by Associate, Hourly Heatmap — CSV on demand"),
    ]):
        cx = x0 + 10 + i * ((wtot - 20) / 3)
        o.append(txt(cx, 302, t, 7.2, INK, 600))
        o.append(lines(cx, 313, wrap(b, 44), 6.4, MUTED, 7.6))
    o.append(varrow(x0 + 60, 270, 284, GOLD_LINE, 1.3))

    # offline band
    o.append(rect(32, 348, 728, 158, WHITE, GATE, 1.2, rx=7))
    o.append(rect(32, 348, 728, 22, GATE_SOFT, None, rx=7))
    o.append(txt(42, 363, "WHEN THE NETWORK IS DOWN — the till keeps trading", 8.4, GATE, 700, family=UNB))
    o.append(txt(750, 363, "verified on the live site, 2026-08-24", 6.6, GATE, anchor="end"))
    flow_row(o, 42, 380, 708, [
        {"t": "The top bar says OFFLINE", "b": ["the heartbeat fails; the till switches to the cached catalogue. Nothing is lost."]},
        {"t": "The sale still rings", "b": ["tiles, scanning, discounts and the 21+ age gate all run on the device."], "k": "gate"},
        {"t": "It goes into the queue", "b": ["written to IndexedDB with a maison_offline_uuid. The top bar reads OFFLINE · n QUEUED."]},
        {"t": "The receipt still prints", "b": ["the device renders it; the QR link only works once the sale has drained."]},
        {"t": "Network returns", "b": ["the queue replays automatically; Queue shows each row pending → ok, with Retry."]},
        {"t": "Nothing double-posts", "b": ["the server matches the uuid and returns the invoice it already made."], "k": "cloud"},
        {"t": "Then the board moves", "b": ["dashboard totals and rewards balances only change once the queue has drained."]},
    ], gap=8, h=76, arrow_y=418)
    o.append(lines(42, 476, wrap(
        "Two rules to teach: (1) a queued sale is a real sale — do not ring it again; (2) anything that needs the "
        "server is unavailable while offline — clock in / out, a card charge on the reader, a return lookup, a client "
        "search, a web order. Take cash, or hold the sale until the connection is back.", 168), 6.7, INK, 8.6))

    legend(o, 32, 530, [("gold", "written by the platform"), ("gate", "a gate or an offline constraint"),
                        ("rule", "an action at the counter")])
    footer(o, "Figure 2 — The sale, and the offline queue")
    return svg(o, "How a sale flows from the counter through the cloud platform to the head-office dashboard, and "
                  "what happens instead when the till is offline: the sale queues on the device and replays without "
                  "double-posting.")


# =============================================================== FIGURE 3
def figure3() -> str:
    o = page_open()
    title_block(o, "Money back, and stock in",
                "A return or exchange at the counter, and the replenishment loop between a store and the Houston warehouse",
                3)

    # ---- A: returns ------------------------------------------------------
    o.append(rect(32, 74, 728, 4, GOLD, None, rx=2))
    o.append(txt(32, 96, "A.  RETURN AND EXCHANGE", 10, INK, 700, family=UNB))
    o.append(txt(215, 96, "at the till  ·  /pos → Returns  ·  the manager approves only when policy says so", 7.2, MUTED))
    flow_row(o, 32, 106, 728, [
        {"t": "Find the sale", "b": ["scan the receipt QR, type the invoice number, or search the client by name, phone or client no."]},
        {"t": "Pick the lines", "b": ["tick each line, set qty or serial, a reason and a condition: Sellable, or Damaged."]},
        {"t": "Choose the refund", "b": ["Original card (Stripe refund), Cash from the drawer, or Store credit (needs a client)."]},
        {"t": "Manager PIN?", "b": ["required over $2,500 incl. tax, or past 30 days (60 for an exchange). An unlocked manager approves implicitly."], "k": "gate"},
        {"t": "Credit note is submitted", "b": ["Sellable goes back to the store's warehouse; Damaged goes to <store> Damaged and cannot be sold."], "k": "cloud"},
        {"t": "Points and commission reverse", "b": ["the points earned on those lines disappear — the balance never goes below zero — and the original seller's commission reverses."], "k": "cloud"},
        {"t": "Return receipt prints", "b": ["RETURN banner, the original sale, the approver, the reason, and its own QR."]},
    ], gap=8, h=92, arrow_y=152)
    o.append(rect(32, 206, 728, 30, BAND, None, rx=4))
    o.append(txt(42, 219, "EXCHANGE INSTEAD:", 7.2, GOLD, 700))
    o.append(txt(122, 219, "the same lines carry over to the Exchange screen. Pick the new items; the till shows "
                           "Client pays (the difference, card or cash), Refund to client (the remainder), or Even exchange.", 6.9, INK))
    o.append(txt(122, 230, "One tap writes both documents; the credit moves through the Exchange Credit account, which nets to "
                           "zero, so only the difference ever touches cash or card.", 6.9, MUTED))

    # ---- B: replenishment ------------------------------------------------
    o.append(rect(32, 258, 728, 4, GOLD, None, rx=2))
    o.append(txt(32, 280, "B.  REPLENISHMENT — STORE ASKS, HOUSTON SHIPS", 10, INK, 700, family=UNB))
    o.append(txt(370, 280, "only the warehouse admin may approve, pick, buy a label or ship", 7.2, MUTED))

    # actor strip above the steps
    bw = (728 - 8 * 6) / 7
    actors = ["STORE MANAGER", "WAREHOUSE ADMIN", "WAREHOUSE", "WAREHOUSE", "WAREHOUSE", "WAREHOUSE", "STORE MANAGER"]
    for i, a in enumerate(actors):
        cx = 32 + i * (bw + 6)
        col = GATE if i == 1 else FAINT
        o.append(txt(cx + bw / 2, 298, a, 6.3, col, 700, anchor="middle", ls="0.4"))
    flow_row(o, 32, 304, 728, [
        {"t": "Request from warehouse", "b": ["POS → Receive → Request from warehouse, or one tap on a low-stock alert.",
                                              "→ AWANZ Replenishment Request + a draft Material Request, HOU-WH → store"]},
        {"t": "Approve, edit or reject", "b": ["/warehouse → Replenishment requests. The quantity can be cut; a rejection needs a reason and notifies the manager.",
                                               "→ AWANZ Shipment (Pending)"], "k": "gate"},
        {"t": "Pick", "b": ["the pick list names the bin for every line; tick them off.",
                            "The wall auto-prints the packing list the moment the shipment appears."]},
        {"t": "Pack", "b": ["build the parcels, confirm weight and dimensions. Check anything unusual before buying a label."]},
        {"t": "Buy the label", "b": ["rates come back from the carrier; the cheapest is pre-selected, Fastest is one tap away.",
                                     "The wall auto-prints the label."]},
        {"t": "Ship", "b": ["→ Stock Entry: HOU-WH → <store> In Transit. The stock is never nowhere — it has left Houston and has not arrived yet."], "k": "cloud"},
        {"t": "Receive by scanning", "b": ["POS → Receive → scan each item to count it in.",
                                           "→ Stock Entry: In Transit → store. Short, over or damaged raises an AWANZ Receiving Discrepancy back to Houston."]},
    ], gap=6, h=122, arrow_y=365)
    o.append(rect(32, 434, 728, 44, BAND, None, rx=4))
    o.append(txt(42, 448, "THE WALL  ( /warehouse-wall )", 7.2, GOLD, 700))
    o.append(txt(180, 448, "Five columns — Pending approval · To pick · Packing · Ready to ship · Shipped today. Cards are ordered by "
                           "priority (Urgent, then Low stock) and then by how long they have waited.", 6.9, INK))
    o.append(txt(180, 459, "The age timer turns amber at 4 hours and red at 24. A newly approved shipment flashes and sounds. "
                           "Under Chrome kiosk-printing, the packing list and the label print with no dialog.", 6.9, MUTED))
    o.append(txt(180, 470, "One kiosk browser can only print to the machine's default printer — so the wall PC prints packing lists and a "
                           "second machine at the pack bench prints labels.", 6.9, MUTED))

    o.append(lines(32, 496, wrap(
        "Partial receipts are supported: save the count as many times as needed; the shipment stays Shipped until the final "
        "confirmation. Cancelling a shipment puts its request back to Pending Approval, cancels the Material Request and tells "
        "the store. A second label is refused unless replace=1 is passed — and the voided one still has to be refunded in the "
        "carrier's own dashboard.", 176), 6.8, MUTED, 8.6))

    legend(o, 32, 546, [("gold", "written by the platform"), ("gate", "someone has to approve"),
                        ("rule", "an action by a person")])
    footer(o, "Figure 3 — Returns, exchanges and replenishment")
    return svg(o, "Two mechanisms: a return or exchange at the till, showing when a manager PIN is required and how "
                  "stock, points and commission reverse; and the replenishment loop where a store manager requests "
                  "stock, the Houston warehouse admin approves, picks, packs, labels and ships it, and the store "
                  "scans it in.")


# =============================================================== FIGURE 4
def figure4() -> str:
    o = page_open()
    title_block(o, "Online orders, and CloudChaserz Rewards",
                "A web order collected at a store counter, and how a point is earned, spent and taken back",
                4)

    # ---- A: click & collect ---------------------------------------------
    o.append(rect(32, 74, 728, 4, GOLD, None, rx=2))
    o.append(txt(32, 96, "A.  WEB ORDER → CLICK & COLLECT", 10, INK, 700, family=UNB))
    o.append(txt(282, 96, "the shopper pays online; the store hands the goods over and invoices only the balance", 7.2, MUTED))
    bw = (728 - 5 * 8) / 6
    for i, a in enumerate(["SHOPPER", "SHOPPER", "THE PLATFORM", "STORE", "STORE", "THE PLATFORM"]):
        cx = 32 + i * (bw + 8)
        o.append(txt(cx + bw / 2, 112, a, 6.3, FAINT, 700, anchor="middle", ls="0.4"))
    flow_row(o, 32, 118, 728, [
        {"t": "Browse and fill the bag", "b": ["/shop. The bag needs an account — /shop/register creates one and signs the shopper straight in.",
                                               "21+ products are not sold online; they read 'Available in store'."]},
        {"t": "Checkout", "b": ["pick the store to collect from and pay online, or choose to pay at the counter."]},
        {"t": "Sales Order", "b": ["maison_web_order = 1, maison_boutique = <code>, status New. Paying online writes a Payment Request, then an advance Payment Entry on the order."], "k": "cloud"},
        {"t": "It lands in the store's queue", "b": ["POS → Web orders. New → Start picking → Mark ready. Enquiries arrive in the same screen."]},
        {"t": "Collect at the counter", "b": ["Collect loads the order into the basket at the price the shopper paid; Pay shows only the balance ($0.00 when fully prepaid)."]},
        {"t": "Sales Invoice", "b": ["is_pos with the advance allocated; the order goes to Collected. Same receipt, same QR, same points, same commission as a counter sale."], "k": "cloud"},
    ], gap=8, h=112, arrow_y=170)

    # ---- B: rewards ------------------------------------------------------
    o.append(rect(32, 254, 728, 4, GOLD, None, rx=2))
    o.append(txt(32, 276, "B.  A POINT, END TO END", 10, INK, 700, family=UNB))
    o.append(txt(216, 276, "$1 = 1 point  ·  $5 off at 100, $10 at 200, $15 at 300  ·  one reward per transaction", 7.2, MUTED))
    flow_row(o, 32, 286, 728, [
        {"t": "Join", "b": ["at the till (Client → New client), on /rewards, or on the client display.",
                            "→ Customer + client number MC###### + client profile with the birthday and home store"]},
        {"t": "Earn", "b": ["ERPNext accrues on the whole bill; AWANZ re-prices the entry onto net_total, so the customer gets a point per dollar of goods — not of tax."], "k": "cloud"},
        {"t": "See it", "b": ["every receipt prints POINTS EARNED, POINTS BALANCE, NEXT REWARD and GIVEAWAY ENTRIES. The client display shows the same."]},
        {"t": "Redeem", "b": ["the Redeem sheet lists only the tiers they can afford and how far the next one is. The reward comes off the grand total."]},
        {"t": "Return", "b": ["points earned on returned lines disappear; the balance never goes negative. A redeemed reward comes back."], "k": "cloud"},
        {"t": "Perks, on a schedule", "b": ["15% birthday coupon issued 7 days ahead, valid 30 · monthly promotion on the 1st · new arrivals weekly · 1 giveaway entry per $25 · event invites."], "k": "cloud"},
    ], gap=8, h=104, arrow_y=330)

    o.append(rect(32, 402, 728, 52, GATE_SOFT, GATE, 1.0, rx=5))
    o.append(txt(42, 418, "WHAT NOT TO PROMISE", 7.6, GATE, 700, family=UNB))
    o.append(lines(42, 430, wrap(
        "Points are tied to the member — their phone number or e-mail — not to a card, so there is nothing to lose. They do not "
        "expire while the account is active. Only one reward tier may be used per transaction. A reward cannot be larger than the "
        "bill. And do not quote a tier that is not on the screen: the till reads the tiers from the platform, so a change made at "
        "head office is live at the next catalogue refresh.", 172), 6.8, INK, 8.6))

    o.append(rect(32, 462, 728, 76, PANEL, RULE, 0.8, rx=5))
    o.append(txt(42, 478, "WHERE THE DATA ENDS UP", 7.6, GOLD, 700, family=UNB))
    for i, (t, b) in enumerate([
        ("Live board", "every sale, within a second: net, tickets, card/cash, returns, low stock, pending approvals, open feedback"),
        ("Products", "a table recomputed every 15 minutes: trending up, new, cooling, steady — chain-wide and per store"),
        ("Clients", "churn risk by tier, follow-up rate per associate, upcoming birthdays, campaign attribution"),
        ("Reports", "eleven reports, each with CSV — tax filings, daily sales, associate, item, RFM, returns, commission"),
    ]):
        cx = 42 + i * 179
        o.append(txt(cx, 494, t, 7.0, INK, 600))
        o.append(lines(cx, 505, wrap(b, 34), 6.4, MUTED, 7.6))

    legend(o, 32, 552, [("gold", "written by the platform"), ("gate", "a rule staff must not overstate"),
                        ("rule", "an action by a person")])
    footer(o, "Figure 4 — Click & collect, and rewards")
    return svg(o, "Two mechanisms: a web order paid online and collected at a store counter, where the invoice "
                  "charges only the balance; and the life of a rewards point from sign-up through earning, "
                  "redemption and reversal on a return.")


# =============================================================================
def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "diagrams")
    os.makedirs(out, exist_ok=True)
    figs = {
        "fig1-system-map.svg": figure1(),
        "fig2-sale-and-offline.svg": figure2(),
        "fig3-returns-and-replenishment.svg": figure3(),
        "fig4-online-and-rewards.svg": figure4(),
    }
    for name, body in figs.items():
        with open(os.path.join(out, name), "w", encoding="utf-8") as fh:
            fh.write(body)
        print("wrote", os.path.join(out, name), len(body), "bytes")

    # the same four figures as one landscape PDF, one figure per page
    from weasyprint import HTML

    pages = "\n".join(
        f'<div class="p"><img src="{os.path.join(out, n)}" alt="AWANZ POS system flowchart page"></div>'
        for n in figs
    )
    doc = (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        "<title>AWANZ POS by CloudChaserz \u2014 System Flowchart</title><style>"
        f"@page {{ size: {W:.0f}pt {H:.0f}pt; margin: 0 }} body {{ margin: 0 }}"
        f".p {{ break-after: page; width: {W:.0f}pt; height: {H:.0f}pt; overflow: hidden }}"
        ".p:last-child { break-after: auto }"
        f"img {{ display: block; width: {W:.0f}pt; height: {H:.0f}pt }}"
        "</style></head><body>" + pages + "</body></html>"
    )
    tmp = os.path.join(here, ".build")
    os.makedirs(tmp, exist_ok=True)
    src = os.path.join(tmp, "flowchart.html")
    with open(src, "w", encoding="utf-8") as fh:
        fh.write(doc)
    pdf = os.path.join(here, "awanz-system-flowchart.pdf")
    HTML(src, base_url=here).write_pdf(pdf)
    print("wrote", pdf)


if __name__ == "__main__":
    main()
