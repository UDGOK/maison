"""AWANZ Store Statement (v1.2 §C) — what each store owes for the stock Houston sent it.

The maths lives in :mod:`maison_pos.reports.store_statement` so that the screen
(``maison_pos.api.pricing.statement``) and this report can never drift apart. The chain total is
built there too rather than left to ``add_total_row``, which would happily add the margin
percentages of eleven stores together.

**Internal.** It shows the AWANZ warehouse's own cost. It is not an invoice and creates no receivable.
"""

from __future__ import annotations

from maison_pos.reports.store_statement import execute  # noqa: F401
