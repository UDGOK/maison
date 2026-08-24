"""Frappe hooks for the AWANZ POS app."""

from . import __version__ as app_version  # noqa: F401

app_name = "maison_pos"
app_title = "AWANZ POS"
app_publisher = "AWANZ"
app_description = "Offline-first luxury retail point of sale on ERPNext v15"
app_email = "dev@awanz.example"
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
# --- v0.6: land every signed-in user on the branded launcher, not the ERPNext desk ---
# Frappe resolves the post-login destination from the apps screen: registering the app
# with `route` and setting System Settings.default_app = "maison_pos" (see
# setup/install.ensure_launcher_home_page) sends staff to /start, which lists exactly
# the screens their roles allow.
add_to_apps_screen = [
	{
		"name": "maison_pos",
		"logo": "/assets/maison_pos/pos/icons/apple-touch-icon.png",
		"title": "Point of Sale",
		"route": "/start",
	}
]
# --- end v0.6 apps screen ---

# --- v0.6: land each role on its own screen instead of the ERPNext desk ---
# Frappe checks these in order and uses the first role the user has. Head Office
# and Regional get the Command dashboard, the warehouse admin the shipping desk,
# and store staff the till — so a demo login never dead-ends on /app.
role_home_page = {
	"AWANZ Head Office": "awanz-dashboard",
	"AWANZ Regional": "awanz-dashboard",
	"AWANZ Warehouse Admin": "warehouse",
	"AWANZ Manager": "pos",
	"AWANZ Associate": "pos",
}
# --- end v0.6 role home pages ---

# --- v0.9 Maison -> AWANZ: keep the old dashboard URL alive ---
# The Command wall moved from /maison-dashboard to /awanz-dashboard. Bookmarks, the
# launcher of an un-migrated tab, `role_home_page` rows written before the rename and
# any link a head-office user mailed around still point at the old path, so it 301s to
# the new one instead of 404ing. Frappe checks `website_redirects` before it resolves a
# page, so this costs nothing on every other request.
website_redirects = [
	{"source": "/maison-dashboard", "target": "/awanz-dashboard"},
	{"source": r"/maison-dashboard/(.*)", "target": r"/awanz-dashboard/\1"},
]
# --- end v0.9 ---

website_route_rules = [
	{"from_route": "/pos/<path:app_path>", "to_route": "pos"},
	{"from_route": "/awanz-dashboard/<path:app_path>", "to_route": "awanz-dashboard"},
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
web_include_css = ["/assets/maison_pos/css/awanz-web.css"]

# --- v0.7 white-label ---
# Nothing in the product surface says "Frappe" or "ERPNext"; every string comes from
# `AWANZ POS Settings` at render time. See `maison_pos/setup/whitelabel.py` and
# `docs/white-label.md` (which records what must legally stay: licences and source-level
# attribution, none of which is UI chrome).
#
# 1. Every www page: drop the "Login with Frappe Cloud" button, keep the tenant favicon /
#    splash / logo / title prefix even when Website Settings has not been applied yet.
update_website_context = ["maison_pos.setup.whitelabel.website_context"]
# 2. Desk (`/app`): brand tokens in `frappe.boot`, and the About dialog (hard-coded to
#    "Frappe Framework" in the framework bundle) replaced by the tenant's.
extend_bootinfo = "maison_pos.setup.whitelabel.extend_bootinfo"
app_include_js = ["/assets/maison_pos/js/awanz-desk.js"]
# 3. The two framework strings that sit outside every Jinja block in `frappe/templates/base.html`
#    (`<!-- Built on Frappe … -->`, `<meta name="generator" content="frappe">`) plus the
#    framework response headers — replaced on the response, the only place they can be reached
#    without forking that template.
after_request = ["maison_pos.setup.whitelabel.scrub_response"]
# 4. Outgoing mail: `X-Frappe-Site` is set on every message by frappe/email/email_body.py.
make_email_body_message = "maison_pos.setup.whitelabel.scrub_email_headers"
# --- end v0.7 white-label ---
# Website Item keeps webshop's data model; only the template + context are AWANZ's
override_doctype_class = {
	"Website Item": "maison_pos.webshop.website_item.AwanzWebsiteItem",
	# chains on webshop's override: the advance Payment Entry is created with elevated rights
	# (portal shoppers have no accounting permissions) and the shopper lands on /shop/order
	"Payment Request": "maison_pos.webshop.payment_request.AwanzPaymentRequest",
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
	{"dt": "Role", "filters": [["name", "like", "AWANZ %"]]},
	{"dt": "Custom Field", "filters": [["name", "like", "%-maison_%"]]},
	{"dt": "Workflow State", "filters": [["name", "in", ["Draft", "Pending Approval", "Approved", "Rejected"]]]},
	{"dt": "Workflow Action Master", "filters": [["name", "in", ["Submit for Approval", "Approve", "Reject"]]]},
	{"dt": "Workflow", "filters": [["name", "=", "AWANZ Price Approval"]]},
	{"dt": "Print Format", "filters": [["name", "in", ["AWANZ Receipt", "AWANZ Return Receipt"]]]},
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
			# v0.8 POS D12 — undoing a return re-prices the original sale's points on the net amount
			"maison_pos.api.rewards.on_return_cancel",
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
		# Monday 06:00: weekly narrative (template / Anthropic) e-mailed to AWANZ Head Office
		"0 6 * * 1": ["maison_pos.insights.jobs.weekly_narrative"],
		# --- end v0.4 H ---
		# --- v0.5 L: AWANZ Product Trend refreshed every 15 min (dashboard Products tab reads it) ---
		"*/15 * * * *": ["maison_pos.insights.trends.compute_trends"],
		# --- end v0.5 L ---
	},
	# v0.4 D — hourly low-stock scan (Item Reorder levels -> AWANZ Stock Alert, idempotent)
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
	"AWANZ Price Change Request": "maison_pos.scoping.price_change_request_query",
	"AWANZ Device Heartbeat": "maison_pos.scoping.heartbeat_query",
	"AWANZ Sync Log": "maison_pos.scoping.sync_log_query",
	"AWANZ Biometric Consent": "maison_pos.scoping.biometric_consent_query",
	"AWANZ Recognition Event": "maison_pos.scoping.recognition_event_query",
	# v0.4 D — inventory alerts / cycle counts scoped to the manager's boutique
	"AWANZ Stock Alert": "maison_pos.scoping.stock_alert_query",
	"AWANZ Cycle Count": "maison_pos.scoping.cycle_count_query",
	# v0.4 B/C/I — boutique-scoped lists for managers / associates
	"AWANZ Client Interaction": "maison_pos.scoping.client_interaction_query",
	"AWANZ Commission Entry": "maison_pos.scoping.commission_entry_query",
	"AWANZ Shift": "maison_pos.scoping.shift_query",
	"AWANZ Feedback": "maison_pos.scoping.feedback_query",
	"AWANZ Coupon Redemption": "maison_pos.scoping.coupon_redemption_query",
	# v0.4 H — boutique-scoped insight rows for managers / associates
	"AWANZ Client Signal": "maison_pos.scoping.client_signal_query",
	"AWANZ Client Recommendation": "maison_pos.scoping.client_recommendation_query",
	# --- v0.5 M — attributed sales scoped to the manager's boutique ---
	"AWANZ Campaign Attribution": "maison_pos.scoping.campaign_attribution_query",
	# --- end v0.5 M ---
	# --- v0.5 K — a Salon (Guest) may read the one session whose token it holds, never list them ---
	"AWANZ Salon Session": "maison_pos.scoping.salon_session_query",
	# --- end v0.5 K ---
	# --- v0.6 N/Q — age checks + giveaway entries scoped to the manager's store ---
	"AWANZ Age Check": "maison_pos.scoping.age_check_query",
	"AWANZ Giveaway Entry": "maison_pos.scoping.giveaway_entry_query",
	# --- end v0.6 N/Q ---
	# --- v0.6 O/P — supply chain docs: managers see their store, warehouse admins everything;
	# ERPNext stock documents in the desk are narrowed to the manager's own warehouses ---
	"AWANZ Replenishment Request": "maison_pos.scoping.replenishment_request_query",
	"AWANZ Shipment": "maison_pos.scoping.shipment_query",
	"AWANZ Receiving Discrepancy": "maison_pos.scoping.receiving_discrepancy_query",
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
	# --- v0.7 S2/S5 — every associate of every store (PIN hashes included) used to be listable
	# by any AWANZ role through `frappe.client.get_list`. A store user now sees their own shop
	# floor and nothing else; `session.associates` / `catalog.bootstrap` are unaffected because
	# they select safe fields explicitly through `frappe.get_all`.
	"AWANZ Associate": "maison_pos.scoping.associate_query",
	# --- v0.7 S6 — the chain-wide client book is no longer bulk-readable from a shop floor
	# (single-client service lookups keep working through `customers.search` / `customers.lookup`).
	"Customer": "maison_pos.scoping.customer_query",
	# --- end v0.7 ---
}

has_permission = {
	"AWANZ Price Change Request": "maison_pos.scoping.price_change_request_has_permission",
	# v0.5 K
	"AWANZ Salon Session": "maison_pos.scoping.salon_session_has_permission",
	# --- v0.6 O/P ---
	"AWANZ Replenishment Request": "maison_pos.scoping.replenishment_request_has_permission",
	"AWANZ Shipment": "maison_pos.scoping.shipment_has_permission",
	"AWANZ Receiving Discrepancy": "maison_pos.scoping.receiving_discrepancy_has_permission",
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
	# --- v0.7 S1/S2/S5 — reads scoped to the caller's own store; writes additionally refused
	# when they would change `user` / `boutique` / `role`, so the escalation fails with a 403
	# instead of silently doing nothing.
	"AWANZ Associate": "maison_pos.scoping.associate_has_permission",
	# --- end v0.7 ---
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
		# v0.8 QA U1 — "Powered by <developer>" for the storefront / receipt footers
		"maison_pos.setup.whitelabel.developer_credit",
		"maison_pos.utils.get_brand_context",
	],
}

# Allow the whitelisted API to be hit from the PWA origin during dev
# (production serves the PWA from the same origin via /pos)
website_context = {
	"favicon": "/assets/maison_pos/favicon.svg",
}
