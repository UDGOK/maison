"""v0.7 white-label — Frappe resolves ``www/404.html``'s controller as ``<app>.www.404``.

The module name is not a Python identifier, so the code lives in :mod:`maison_pos.www.error_404`
(importable, and therefore testable) and this file only re-exports it.
"""

from maison_pos.www.error_404 import get_context, no_cache, sitemap  # noqa: F401
