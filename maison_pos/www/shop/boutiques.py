"""/shop/boutiques — the boutiques (address, phone, hours)."""

from __future__ import annotations

from maison_pos.webshop import core
from maison_pos.www.shop._common import base_context

no_cache = 1


def get_context(context):
	base_context(context, nav="boutiques", title="Boutiques — Maison")
	context.boutiques = core.boutiques()
