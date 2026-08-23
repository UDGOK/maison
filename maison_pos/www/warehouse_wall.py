"""Serve the 55\" Warehouse Wall (v0.6 P) at ``/warehouse-wall`` (same bundle, own layout)."""

from __future__ import annotations

from maison_pos.www.warehouse import _context

no_cache = 1


def get_context(context: dict) -> dict:
	return _context(context, "Warehouse Wall", "/warehouse-wall")
