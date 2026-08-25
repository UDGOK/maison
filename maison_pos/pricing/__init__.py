"""Pricing (v1.2 "What each store owes, and what each store charges").

Two prices live here and they are not the same thing:

``pricing/wholesale.py``
    What the **store** pays Houston for a unit of stock. A chain-wide markup on what Houston
    actually paid (the moving-average valuation at the main warehouse), with a per-item override
    that wins when it is set. Resolved live for the screens, and **stamped onto a shipment the
    moment it ships** so the figure a statement is billed from can never move afterwards.

``reports/store_statement.py``
    The month-end statement built from those stamps — one row per store per period.

Retail (what a **client** pays in a shop) is not here: it is the ``AWANZ Price Change Request`` +
``AWANZ Price Approval`` workflow that has existed since v0.1, exposed by
``maison_pos.api.purchasing``. ``maison_pos.api.pricing.store_prices`` puts the two side by side
so a manager can see the margin a proposed shelf price implies.

**This module changes no accounting.** Stock still moves at cost — the wholesale figure rides
alongside for reporting. Nothing here creates an invoice, a receivable or a ledger entry.
"""

from __future__ import annotations

from maison_pos.pricing.wholesale import (  # noqa: F401
	DEFAULT_MARKUP_PCT,
	MARKUP_FIELD,
	OVERRIDE_FIELD,
	cost_for,
	cost_rate,
	markup_pct,
	set_markup_pct,
	set_override,
	stamp_shipment,
	wholesale_for,
	wholesale_rate,
)
