"""AWANZ insights (SPEC v0.4 §H): affinity / next-best-offer, client signals, product
performance + rebalancing, and the weekly narrative.

Pure-python analytics (the bench env has no numpy / pandas). Each module exposes math helpers
that take plain dicts / lists — unit-testable without a site — plus loaders that read
ERPNext data through ``frappe``. ``jobs.py`` wires them into the scheduler; ``maison_pos.api.insights``
exposes the endpoints.
"""
