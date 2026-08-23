"""Frappe hooks for the Maison POS app."""

from . import __version__ as app_version  # noqa: F401

app_name = "maison_pos"
app_title = "Maison POS"
app_publisher = "Maison"
app_description = "Offline-first luxury retail point of sale on ERPNext v15"
app_email = "dev@maison.example"
app_license = "MIT"
# v0.4: hrms (Employee Checkin, Additional Salary / Payroll) and crm (Frappe CRM: CRM Task, Contact)
# are installed alongside; the glue feature-detects both and degrades gracefully when absent.
# `crm`, `webshop` and `payments` are optional: every integration point is
# feature-detected (see maison_pos.api.crm.crm_installed / webshop.core).
# Frappe CRM `main` currently fails `yarn install` on the Frappe Cloud v15
# builder image, so it must not be a hard requirement.
required_apps = ["erpnext", "hrms"]

# ---------------------------------------------------------------------------
# Website / PWA shell
# ---------------------------------------------------------------------------
website_route_rules = [
	{"from_route": "/pos/<path:app_path>", "to_route": "pos"},
	{"from_route": "/maison-dashboard/<path:app_path>", "to_route": "maison-dashboard"},
	# public receipt page (token from the QR printed on the receipt)
	{"from_route": "/r/<token>", "to_route": "r"},
	# --- v0.5 K (salon): client-facing screen, same PWA bundle, own layout ---
	{"from_route": "/salon/<path:app_path>", "to_route": "salon"},
	# --- end v0.5 K ---
	# --- v0.6 Q — public rewards page on the web shop ---
	{"from_route": "/rewards/<path:app_path>", "to_route": "rewards"},
	# --- end v0.6 Q ---
	# --- v0.6 P (warehouse): admin desk + 55" wall share the POS bundle; simulated label page ---
	{"from_route": "/warehouse/<path:app_path>", "to_route": "warehouse"},
	{"from_route": "/warehouse-wall/<path:app_path>", "to_route": "warehouse-wall"},
	{"from_route": "/shipping-label/<tracking_no>", "to_route": "shipping-label"},
	# --- end v0.6 P ---
	# --- v0.4 G (webshop): Monolith Gold storefront pages take over webshop's /cart and /all-products ---
	{"from_route": "/cart", "to_route": "shop/cart"},
	{"from_route": "/all-products", "to_route": "shop/collection"},
	# --- end v0.4 G ---
]

# --- v0.4 G (webshop): gold skin for every website page (login, /me, /orders, webshop item groups) ---
web_include_css = ["/assets/maison_pos/css/maison-web.css"]
# Website Item keeps webshop's data model; only the template + context are Maison's
override_doctype_class = {
	"Website Item": "maison_pos.webshop.website_item.MaisonWebsiteItem",
	# chains on webshop's override: the advance Payment Entry is created with elevated rights
	# (portal shoppers have no accounting permissions) and the shopper lands on /shop/order
	"Payment Request": "maison_pos.webshop.payment_request.MaisonPaymentRequest",
}
# --- end v0.4 G ---

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
after_install = "maison_pos.setup.install.after_install"
after_migrate = "maison_pos.setup.install.after_migrate"
# v0.4 H — ERPNext's before_tests wipes `tabItem Price` (and commits) on every `bench run-tests`;
# put the demo prices back so the dev site's POS keeps working after a test run.
before_tests = "maison_pos.setup.demo.before_tests"

# ---------------------------------------------------------------------------
# Fixtures (exported with `bench --site X export-fixtures`)
# ---------------------------------------------------------------------------
fixtures = [
	{"dt": "Role", "filters": [["name", "like", "Maison %"]]},
	{"dt": "Custom Field", "filters": [["name", "like", "%-maison_%"]]},
	{"dt": "Workflow State", "filters": [["name", "in", ["Draft", "Pending Approval", "Approved", "Rejected"]]]},
	{"dt": "Workflow Action Master", "filters": [["name", "in", ["Submit for Approval", "Approve", "Reject"]]]},
	{"dt": "Workflow", "filters": [["name", "=", "Maison Price Approval"]]},
	{"dt": "Print Format", "filters": [["name", "in", ["Maison Receipt", "Maison Return Receipt"]]]},
]

# ---------------------------------------------------------------------------
# Document events
# ---------------------------------------------------------------------------
doc_events = {
	"Sales Invoice": {
		"validate": "maison_pos.events.sales_invoice.validate",
		"before_submit": "maison_pos.events.sales_invoice.before_submit",
		"on_submit": [
			"maison_pos.events.sales_invoice.on_submit",
			# v0.4 B/C/I — commissions, coupon redemption, wishlist fulfilment
			"maison_pos.api.hr.on_invoice_submit",
			"maison_pos.api.promotions.on_invoice_submit",
			"maison_pos.api.crm.fulfil_wishlist_on_sale",
			# v0.4 G — web order collected at the counter -> Sales Order status Collected
			"maison_pos.webshop.events.on_invoice_submit",
			# --- v0.6 Q — giveaway entries (+ age-check link), entries reversed by a credit note ---
			"maison_pos.api.rewards.on_invoice_submit",
			"maison_pos.api.rewards.on_return_submit",
			# --- end v0.6 Q ---
		],
		"on_cancel": [
			"maison_pos.events.sales_invoice.on_cancel",
			# v0.4 C/I — commission reversal, coupon use returned
			"maison_pos.api.hr.on_invoice_cancel",
			"maison_pos.api.promotions.on_invoice_cancel",
			# v0.4 G — collection undone
			"maison_pos.webshop.events.on_invoice_cancel",
			# v0.6 Q — giveaway entries reversed
			"maison_pos.api.rewards.on_invoice_cancel",
		],
	},
	# v0.4 B — wishlist alerts when a wished item arrives in a boutique warehouse
	"Stock Entry": {
		"on_submit": "maison_pos.api.crm.on_stock_entry_submit",
	},
	"Customer": {
		"before_insert": "maison_pos.events.customer.before_insert",
		"validate": "maison_pos.events.customer.validate",
		"on_update": "maison_pos.events.customer.on_update",
	},
}

# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
scheduler_events = {
	"cron": {
		# every 2 minutes: flag devices whose heartbeat is stale and notify the live wall
		"*/2 * * * *": ["maison_pos.tasks.check_heartbeat_staleness"],
		# --- v0.4 H insights (site time zone) ---
		# Monday 05:00: affinity cache, client signals, rebalance suggestions
		"0 5 * * 1": ["maison_pos.insights.jobs.compute_weekly"],
		# Monday 06:00: weekly narrative (template / Anthropic) e-mailed to Maison Head Office
		"0 6 * * 1": ["maison_pos.insights.jobs.weekly_narrative"],
		# --- end v0.4 H ---
		# --- v0.5 L: Maison Product Trend refreshed every 15 min (dashboard Products tab reads it) ---
		"*/15 * * * *": ["maison_pos.insights.trends.compute_trends"],
		# --- end v0.5 L ---
	},
	# v0.4 D — hourly low-stock scan (Item Reorder levels -> Maison Stock Alert, idempotent)
	"hourly": [
		"maison_pos.api.inventory.low_stock_scan",
		# v0.5 K — salon sessions past 12 h -> Expired
		"maison_pos.api.salon.expire_sessions",
		# v0.6 P — carrier tracking refresh for shipped consignments
		"maison_pos.api.shipping.refresh_tracking",
	],
	# v0.6 Q — "New arrivals" auto-segment campaign (weekly)
	"weekly": ["maison_pos.api.rewards.new_arrivals_campaign"],
	"daily": [
		"maison_pos.tasks.purge_old_sync_logs",
		# BIPA retention policy: destroy face templates of clients with no visit in N months
		"maison_pos.tasks.purge_expired_biometrics",
		# v0.4 D — low-stock e-mail digest to Head Office + boutique managers
		"maison_pos.api.inventory.low_stock_digest",
		# v0.4 I — loyalty birthday bonus (no-op when birthday_bonus_points = 0)
		"maison_pos.api.promotions.birthday_bonus",
		# --- v0.5 M — nightly campaign attribution (last-touch 14 d + assisted 30 d + item-level) ---
		"maison_pos.campaigns.attribution.nightly",
		# --- end v0.5 M ---
		# --- v0.6 Q — CloudChaserz Rewards: birthday coupons (7 d ahead), monthly promotions (acts on the 1st) ---
		"maison_pos.api.rewards.issue_birthday_coupons",
		"maison_pos.api.rewards.send_monthly_promotions",
		# --- end v0.6 Q ---
	],
}

# ---------------------------------------------------------------------------
# Permissions / scoping helpers
# ---------------------------------------------------------------------------
permission_query_conditions = {
	"Maison Price Change Request": "maison_pos.scoping.price_change_request_query",
	"Maison Device Heartbeat": "maison_pos.scoping.heartbeat_query",
	"Maison Sync Log": "maison_pos.scoping.sync_log_query",
	"Maison Biometric Consent": "maison_pos.scoping.biometric_consent_query",
	"Maison Recognition Event": "maison_pos.scoping.recognition_event_query",
	# v0.4 D — inventory alerts / cycle counts scoped to the manager's boutique
	"Maison Stock Alert": "maison_pos.scoping.stock_alert_query",
	"Maison Cycle Count": "maison_pos.scoping.cycle_count_query",
	# v0.4 B/C/I — boutique-scoped lists for managers / associates
	"Maison Client Interaction": "maison_pos.scoping.client_interaction_query",
	"Maison Commission Entry": "maison_pos.scoping.commission_entry_query",
	"Maison Shift": "maison_pos.scoping.shift_query",
	"Maison Feedback": "maison_pos.scoping.feedback_query",
	"Maison Coupon Redemption": "maison_pos.scoping.coupon_redemption_query",
	# v0.4 H — boutique-scoped insight rows for managers / associates
	"Maison Client Signal": "maison_pos.scoping.client_signal_query",
	"Maison Client Recommendation": "maison_pos.scoping.client_recommendation_query",
	# --- v0.5 M — attributed sales scoped to the manager's boutique ---
	"Maison Campaign Attribution": "maison_pos.scoping.campaign_attribution_query",
	# --- end v0.5 M ---
	# --- v0.5 K — a Salon (Guest) may read the one session whose token it holds, never list them ---
	"Maison Salon Session": "maison_pos.scoping.salon_session_query",
	# --- end v0.5 K ---
	# --- v0.6 N/Q — age checks + giveaway entries scoped to the manager's store ---
	"Maison Age Check": "maison_pos.scoping.age_check_query",
	"Maison Giveaway Entry": "maison_pos.scoping.giveaway_entry_query",
	# --- end v0.6 N/Q ---
	# --- v0.6 O/P — supply chain docs: managers see their store, warehouse admins everything;
	# ERPNext stock documents in the desk are narrowed to the manager's own warehouses ---
	"Maison Replenishment Request": "maison_pos.scoping.replenishment_request_query",
	"Maison Shipment": "maison_pos.scoping.shipment_query",
	"Maison Receiving Discrepancy": "maison_pos.scoping.receiving_discrepancy_query",
	"Stock Entry": "maison_pos.scoping.stock_entry_query",
	"Material Request": "maison_pos.scoping.material_request_query",
	"Purchase Receipt": "maison_pos.scoping.purchase_receipt_query",
	"Purchase Order": "maison_pos.scoping.purchase_order_query",
	# --- end v0.6 O/P ---
	# --- v0.6 D3 — the generic REST list surface. `Sales Invoice` used to rely only on the
	# per-user Warehouse User Permission, which credit notes escape (no `set_warehouse`), so a
	# store manager could list every other store's returns through `frappe.client.get_list` /
	# `/api/resource/Sales Invoice`. Scoped on `maison_boutique` here, independently of the stamp.
	"Sales Invoice": "maison_pos.scoping.sales_invoice_query",
	"Sales Order": "maison_pos.scoping.sales_order_query",
	"Delivery Note": "maison_pos.scoping.delivery_note_query",
	# --- end v0.6 D3 ---
}

has_permission = {
	"Maison Price Change Request": "maison_pos.scoping.price_change_request_has_permission",
	# v0.5 K
	"Maison Salon Session": "maison_pos.scoping.salon_session_has_permission",
	# --- v0.6 O/P ---
	"Maison Replenishment Request": "maison_pos.scoping.replenishment_request_has_permission",
	"Maison Shipment": "maison_pos.scoping.shipment_has_permission",
	"Maison Receiving Discrepancy": "maison_pos.scoping.receiving_discrepancy_has_permission",
	"Stock Entry": "maison_pos.scoping.stock_entry_has_permission",
	"Material Request": "maison_pos.scoping.material_request_has_permission",
	"Purchase Receipt": "maison_pos.scoping.purchase_receipt_has_permission",
	"Purchase Order": "maison_pos.scoping.purchase_order_has_permission",
	# --- end v0.6 O/P ---
	# --- v0.6 D3 — `frappe.client.get` / `/api/resource/<dt>/<name>` on another store's document
	"Sales Invoice": "maison_pos.scoping.sales_invoice_has_permission",
	"Sales Order": "maison_pos.scoping.sales_order_has_permission",
	"Delivery Note": "maison_pos.scoping.delivery_note_has_permission",
	# --- end v0.6 D3 ---
}

# ---------------------------------------------------------------------------
# Jinja helpers available to print formats
# ---------------------------------------------------------------------------
jinja = {
	"methods": [
		"maison_pos.utils.get_receipt_context",
		"maison_pos.utils.format_money",
		"maison_pos.utils.receipt_qr_svg",
		# v0.6 P — packing list (shipment QR, line barcodes)
		"maison_pos.api.shipping.packing_list_context",
		# v0.4 G — storefront templates (header cart count, boutiques, money formatting)
		"maison_pos.webshop.context.shop_context",
		"maison_pos.webshop.context.shop_money",
		# v0.6 R — store names without the repeated brand prefix ("Broken Arrow", not "CloudChaserz Broken Arrow")
		"maison_pos.webshop.context.shop_store_name",
		# v0.6 N — brand tokens in every template (receipts, e-mails, shop)
		"maison_pos.brand.get_brand",
		"maison_pos.utils.get_brand_context",
	],
}

# Allow the whitelisted API to be hit from the PWA origin during dev
# (production serves the PWA from the same origin via /pos)
website_context = {
	"favicon": "/assets/maison_pos/favicon.svg",
}
