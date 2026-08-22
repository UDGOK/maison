"""Frappe hooks for the Maison POS app."""

from . import __version__ as app_version  # noqa: F401

app_name = "maison_pos"
app_title = "Maison POS"
app_publisher = "Maison"
app_description = "Offline-first luxury retail point of sale on ERPNext v15"
app_email = "dev@maison.example"
app_license = "MIT"
required_apps = ["erpnext"]

# ---------------------------------------------------------------------------
# Website / PWA shell
# ---------------------------------------------------------------------------
website_route_rules = [
	{"from_route": "/pos/<path:app_path>", "to_route": "pos"},
	{"from_route": "/maison-dashboard/<path:app_path>", "to_route": "maison-dashboard"},
	# public receipt page (token from the QR printed on the receipt)
	{"from_route": "/r/<token>", "to_route": "r"},
]

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
after_install = "maison_pos.setup.install.after_install"
after_migrate = "maison_pos.setup.install.after_migrate"

# ---------------------------------------------------------------------------
# Fixtures (exported with `bench --site X export-fixtures`)
# ---------------------------------------------------------------------------
fixtures = [
	{"dt": "Role", "filters": [["name", "like", "Maison %"]]},
	{"dt": "Custom Field", "filters": [["name", "like", "%-maison_%"]]},
	{"dt": "Workflow State", "filters": [["name", "in", ["Draft", "Pending Approval", "Approved", "Rejected"]]]},
	{"dt": "Workflow Action Master", "filters": [["name", "in", ["Submit for Approval", "Approve", "Reject"]]]},
	{"dt": "Workflow", "filters": [["name", "=", "Maison Price Approval"]]},
	{"dt": "Print Format", "filters": [["name", "=", "Maison Receipt"]]},
]

# ---------------------------------------------------------------------------
# Document events
# ---------------------------------------------------------------------------
doc_events = {
	"Sales Invoice": {
		"validate": "maison_pos.events.sales_invoice.validate",
		"before_submit": "maison_pos.events.sales_invoice.before_submit",
		"on_submit": "maison_pos.events.sales_invoice.on_submit",
		"on_cancel": "maison_pos.events.sales_invoice.on_cancel",
	},
	"Customer": {
		"before_insert": "maison_pos.events.customer.before_insert",
		"validate": "maison_pos.events.customer.validate",
	},
}

# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
scheduler_events = {
	"cron": {
		# every 2 minutes: flag devices whose heartbeat is stale and notify the live wall
		"*/2 * * * *": ["maison_pos.tasks.check_heartbeat_staleness"],
	},
	"daily": ["maison_pos.tasks.purge_old_sync_logs"],
}

# ---------------------------------------------------------------------------
# Permissions / scoping helpers
# ---------------------------------------------------------------------------
permission_query_conditions = {
	"Maison Price Change Request": "maison_pos.scoping.price_change_request_query",
	"Maison Device Heartbeat": "maison_pos.scoping.heartbeat_query",
	"Maison Sync Log": "maison_pos.scoping.sync_log_query",
}

has_permission = {
	"Maison Price Change Request": "maison_pos.scoping.price_change_request_has_permission",
}

# ---------------------------------------------------------------------------
# Jinja helpers available to print formats
# ---------------------------------------------------------------------------
jinja = {
	"methods": [
		"maison_pos.utils.get_receipt_context",
		"maison_pos.utils.format_money",
		"maison_pos.utils.receipt_qr_svg",
	],
}

# Allow the whitelisted API to be hit from the PWA origin during dev
# (production serves the PWA from the same origin via /pos)
website_context = {
	"favicon": "/assets/maison_pos/favicon.svg",
}
