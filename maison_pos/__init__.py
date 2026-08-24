# Bump this on every release. Frappe Cloud compares `__version__` between benches and does an
# "Update Site *Pull*" — assets only, **no migrate** — when it is unchanged, which is how a
# previous release's patches silently never ran.
__version__ = "1.0.0"
