"""v0.6 O/P — replenishment approval, shipment lifecycle + in-transit stock postings, partial /
short / damaged receipt → discrepancies, rate adapters (simulated by zone / weight, Shippo with
mocked HTTP), wall / endpoint scoping, warehouse admin cannot sell."""

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate, nowtime

from maison_pos.api import inventory, sales, shipping
from maison_pos.shipping import ensure_transit_warehouse, get_main_warehouse
from maison_pos.shipping.providers import ShippingError, pick_rate
from maison_pos.shipping.providers.shippo import ShippoProvider
from maison_pos.shipping.providers.simulated import SimulatedProvider, billable_lb, distance_miles, usps_zone
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

ITEM = "AC-012"
ITEM2 = "AC-001"
WH_ADMIN = "wh.test@maison.example"
STORE = "NYC-5AV"
OTHER = "CHI-OAK"


def _manager(boutique: str) -> str:
	return frappe.db.get_value("Maison Associate", {"boutique": boutique, "role": "Manager", "enabled": 1}, "user")


def _company(boutique: str = STORE) -> str:
	"""Company of the demo store under test — a bench may carry a second brand's company too."""
	return frappe.db.get_value("Maison Boutique", boutique, "company")


def _source_warehouse(exclude: str | None = None, boutique: str = STORE) -> str:
	"""The replenishment source for *boutique*, restricted to its own company (v0.6 P)."""
	return get_main_warehouse(exclude=exclude, company=_company(boutique))


def _bin(item: str, warehouse: str) -> float:
	return flt(frappe.db.get_value("Bin", {"item_code": item, "warehouse": warehouse}, "actual_qty"))


def ensure_warehouse_admin(email: str = WH_ADMIN) -> str:
	if not frappe.db.exists("User", email):
		u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "Wanda", "last_name": "Houston", "send_welcome_email": 0, "enabled": 1, "new_password": "maison123", "user_type": "System User"})
		u.flags.ignore_permissions = True
		u.flags.no_welcome_mail = True
		u.flags.ignore_password_policy = True
		u.insert()
	u = frappe.get_doc("User", email)
	if "Maison Warehouse Admin" not in {r.role for r in u.roles}:
		u.append("roles", {"role": "Maison Warehouse Admin"})
		u.flags.ignore_permissions = True
		u.save()
	return email


def stock_main_warehouse(item: str, qty: float, warehouse: str | None = None) -> str:
	warehouse = warehouse or _source_warehouse()
	company = frappe.db.get_value("Warehouse", warehouse, "company")
	se = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "purpose": "Material Receipt", "company": company, "to_warehouse": warehouse, "posting_date": nowdate(), "posting_time": nowtime(), "set_posting_time": 1, "items": [{"item_code": item, "qty": qty, "t_warehouse": warehouse, "basic_rate": 10}]})
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	return warehouse


class TestWarehouse(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		ensure_warehouse_admin()

	def setUp(self):
		frappe.set_user("Administrator")
		self.sp = f"maison_wh_{frappe.generate_hash(length=6)}"
		frappe.db.savepoint(self.sp)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self.sp)

	# ------------------------------------------------------------------ helpers
	def _request(self, boutique: str = STORE, qty: float = 4, item: str = ITEM, **kw):
		frappe.set_user(_manager(boutique))
		out = inventory.replenish(boutique, lines=[{"item_code": item, "qty": qty}], **kw)
		frappe.set_user("Administrator")
		return out["request"]

	def _approved_shipment(self, qty: float = 4, approve_qty: float | None = None, item: str = ITEM):
		stock_main_warehouse(item, 20, _source_warehouse(exclude=frappe.db.get_value("Maison Boutique", STORE, "warehouse")))
		req = self._request(qty=qty, item=item)
		frappe.set_user(WH_ADMIN)
		lines = [{"item_code": item, "approved_qty": approve_qty}] if approve_qty is not None else None
		out = shipping.approve(req["name"], lines=lines)
		return out["shipment"]

	# ------------------------------------------------------------------ requests / workflow
	def test_manager_request_creates_draft_material_request_and_warehouse_admin_approves_with_edited_qty(self):
		req = self._request(qty=6)
		self.assertEqual(req["status"], "Pending Approval")
		self.assertEqual(req["from_warehouse"], _source_warehouse(exclude=req["to_warehouse"]))
		mr = frappe.get_doc("Material Request", req["material_request"])
		self.assertEqual((mr.docstatus, mr.material_request_type, mr.set_warehouse), (0, "Material Transfer", req["to_warehouse"]))
		# a store manager may not approve
		frappe.set_user(_manager(STORE))
		with self.assertRaises(frappe.PermissionError):
			shipping.approve(req["name"])
		frappe.set_user(WH_ADMIN)
		out = shipping.approve(req["name"], lines=[{"item_code": ITEM, "approved_qty": 4}], notes="only 4 on hand")
		self.assertEqual(out["request"]["status"], "Approved")
		self.assertEqual(out["request"]["lines"][0]["approved_qty"], 4)
		self.assertEqual(out["request"]["approved_by"], WH_ADMIN)
		sh = out["shipment"]
		self.assertEqual((sh["status"], sh["units"], sh["boutique"]), ("Pending", 4.0, STORE))
		self.assertTrue(sh["transit_warehouse"].endswith("In Transit - MSN"))
		mr.reload()
		self.assertEqual((mr.docstatus, flt(mr.items[0].qty)), (1, 4.0))
		self.assertGreater(sh["est_weight"], 0)

	def test_reject_requires_reason_and_notifies_the_manager(self):
		req = self._request(qty=2)
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			shipping.reject(req["name"], "")
		out = shipping.reject(req["name"], "Not stocked at HQ")
		self.assertEqual(out["request"]["status"], "Rejected")
		self.assertEqual(out["request"]["rejection_reason"], "Not stocked at HQ")
		self.assertFalse(frappe.db.exists("Material Request", req["material_request"]))
		notes = frappe.get_all("Notification Log", filters={"for_user": _manager(STORE), "document_name": req["name"]}, pluck="subject")
		self.assertTrue(any("rejected" in n.lower() for n in notes), notes)
		frappe.set_user(_manager(STORE))
		self.assertEqual(inventory.replenishment_requests(STORE)["requests"][0]["rejection_reason"], "Not stocked at HQ")

	def test_low_stock_one_tap_request_marks_priority_and_links_the_alert(self):
		wh = frappe.db.get_value("Maison Boutique", STORE, "warehouse")
		alert = frappe.get_doc({"doctype": "Maison Stock Alert", "item_code": ITEM, "warehouse": wh, "boutique": STORE, "status": "Open", "qty": 1, "reorder_level": 3, "reorder_qty": 5}).insert(ignore_permissions=True)
		frappe.set_user(_manager(STORE))
		out = inventory.replenish(item=ITEM, alert=alert.name)
		self.assertEqual(out["request"]["priority"], "Low stock")
		self.assertEqual(out["request"]["lines"][0]["qty"], 5.0)
		self.assertEqual(out["request"]["lines"][0]["stock_alert"], alert.name)
		self.assertEqual(frappe.db.get_value("Maison Stock Alert", alert.name, "status"), "Acknowledged")

	# ------------------------------------------------------------------ lifecycle + stock
	def test_shipment_lifecycle_posts_in_transit_then_store_receipt(self):
		sh = self._approved_shipment(qty=4)
		src, transit, dest = sh["from_warehouse"], sh["transit_warehouse"], sh["to_warehouse"]
		before = (_bin(ITEM, src), _bin(ITEM, transit), _bin(ITEM, dest))
		frappe.set_user(WH_ADMIN)
		self.assertEqual(shipping.pick(sh["name"])["status"], "Picking")
		packed = shipping.pack(sh["name"], parcels=[{"length": 40, "width": 30, "height": 25, "weight": 1.2}])
		self.assertEqual((packed["status"], packed["packages"], packed["total_weight"]), ("Packed", 1, 1.2))
		quote = shipping.rates(sh["name"])
		self.assertEqual(quote["selected"]["provider_rate_id"], quote["cheapest"])
		bought = shipping.buy(sh["name"], quote["selected"]["provider_rate_id"])
		self.assertTrue(bought["tracking_no"] and bought["label_url"].startswith("/shipping-label/"))
		shipped = shipping.ship(sh["name"])
		self.assertEqual(shipped["status"], "Shipped")
		se = frappe.get_doc("Stock Entry", shipped["stock_entry_ship"])
		self.assertEqual((se.docstatus, se.purpose, se.from_warehouse, se.to_warehouse), (1, "Material Transfer", src, transit))
		self.assertEqual(_bin(ITEM, src), before[0] - 4)
		self.assertEqual(_bin(ITEM, transit), before[1] + 4)
		self.assertEqual(frappe.db.get_value("Material Request", sh["material_request"], "status"), "Transferred")
		# the wall column moved to "shipped today"
		wall = shipping.wall()
		self.assertIn(sh["name"], [c["name"] for c in wall["columns"]["shipped_today"]])
		# store receives in full
		frappe.set_user(_manager(STORE))
		inbound = inventory.inbound(STORE)
		self.assertEqual([s["name"] for s in inbound["shipments"]], [sh["name"]])
		received = inventory.receive_shipment(sh["name"])
		self.assertEqual(received["status"], "Received")
		self.assertEqual(received["discrepancies"], [])
		se2 = frappe.get_doc("Stock Entry", received["stock_entry_receive"])
		self.assertEqual((se2.from_warehouse, se2.to_warehouse, flt(se2.items[0].qty)), (transit, dest, 4.0))
		self.assertEqual(_bin(ITEM, transit), before[1])
		self.assertEqual(_bin(ITEM, dest), before[2] + 4)
		self.assertTrue(frappe.db.get_value("Maison Shipment", sh["name"], "received_by"), _manager(STORE))

	def test_partial_short_and_damaged_receipt_raises_discrepancies(self):
		sh = self._approved_shipment(qty=6)
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh["name"])
		transit, dest = sh["transit_warehouse"], sh["to_warehouse"]
		damaged_wh = frappe.db.get_value("Maison Boutique", STORE, "damaged_warehouse")
		t0, d0, dm0 = _bin(ITEM, transit), _bin(ITEM, dest), _bin(ITEM, damaged_wh) if damaged_wh else 0
		frappe.set_user(_manager(STORE))
		# first carton: 2 good, not final
		part = inventory.receive_shipment(sh["name"], lines=[{"item_code": ITEM, "received_qty": 2}], final=0)
		self.assertEqual(part["status"], "Shipped")
		self.assertEqual(_bin(ITEM, dest), d0 + 2)
		self.assertEqual(part["discrepancies"], [])
		# final: 1 more good, 1 damaged, 2 short
		fin = inventory.receive_shipment(sh["name"], lines=[{"item_code": ITEM, "received_qty": 1, "damaged_qty": 1}], final=1, notes="carton crushed")
		self.assertEqual(fin["status"], "Received")
		line = fin["lines"][0]
		self.assertEqual((line["received_qty"], line["damaged_qty"], line["short_qty"], line["over_qty"]), (3.0, 1.0, 2.0, 0.0))
		self.assertEqual(_bin(ITEM, dest), d0 + 3)
		if damaged_wh:
			self.assertEqual(_bin(ITEM, damaged_wh), dm0 + 1)
		self.assertEqual(_bin(ITEM, transit), t0 - 4)  # 2 short units still sit in transit
		kinds = sorted(frappe.db.get_value("Maison Receiving Discrepancy", n, "type") for n in fin["discrepancies"])
		self.assertEqual(kinds, ["Damaged", "Short"])
		# warehouse admin resolves the short by writing off the transit stock
		frappe.set_user(WH_ADMIN)
		short = next(n for n in fin["discrepancies"] if frappe.db.get_value("Maison Receiving Discrepancy", n, "type") == "Short")
		res = shipping.resolve_discrepancy(short, "Write off", notes="lost in transit")
		self.assertEqual(res["status"], "Resolved")
		self.assertTrue(res["stock_entry"])
		self.assertEqual(_bin(ITEM, transit), t0 - 6)
		self.assertEqual(shipping.discrepancies("Open")["count"], 1)

	def test_over_receipt_is_recorded_without_moving_phantom_stock(self):
		sh = self._approved_shipment(qty=2)
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh["name"])
		transit, dest = sh["transit_warehouse"], sh["to_warehouse"]
		t0, d0 = _bin(ITEM, transit), _bin(ITEM, dest)
		frappe.set_user(_manager(STORE))
		fin = inventory.receive_shipment(sh["name"], lines=[{"item_code": ITEM, "received_qty": 3}])
		self.assertEqual(fin["lines"][0]["over_qty"], 1.0)
		self.assertEqual(_bin(ITEM, dest), d0 + 2)
		self.assertEqual(_bin(ITEM, transit), t0 - 2)
		self.assertEqual(frappe.db.get_value("Maison Receiving Discrepancy", fin["discrepancies"][0], "type"), "Over")

	def test_cannot_ship_twice_or_cancel_after_shipping(self):
		sh = self._approved_shipment(qty=1)
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh["name"])
		with self.assertRaises(frappe.ValidationError):
			shipping.ship(sh["name"])
		with self.assertRaises(frappe.ValidationError):
			shipping.mark(sh["name"], "Cancelled")
		frappe.set_user(_manager(STORE))
		inventory.receive_shipment(sh["name"])
		with self.assertRaises(frappe.ValidationError):
			inventory.receive_shipment(sh["name"])

	def test_tracking_refresh_walks_the_simulated_timeline(self):
		sh = self._approved_shipment(qty=1)
		frappe.set_user(WH_ADMIN)
		shipping.buy(sh["name"])
		shipping.ship(sh["name"])
		t = shipping.track(sh["name"])
		self.assertIn(t["status"], ("PRE_TRANSIT", "TRANSIT"))
		self.assertTrue(t["events"])
		out = shipping.refresh_tracking()
		self.assertGreaterEqual(out["checked"], 1)
		self.assertEqual(frappe.db.get_value("Maison Shipment", sh["name"], "tracking_status"), t["status"])

	def test_supply_summary_and_dashboard_block(self):
		sh = self._approved_shipment(qty=1)
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh["name"])
		s = shipping.supply_summary()
		self.assertGreaterEqual(s["in_transit"], 1)
		self.assertIsNotNone(s["avg_approve_to_ship_hours"])
		frappe.set_user("Administrator")
		from maison_pos.api import dashboard

		self.assertIn("in_transit", dashboard.live_summary()["supply"])

	# ------------------------------------------------------------------ scoping
	def test_manager_cannot_read_approve_or_receive_other_store(self):
		sh = self._approved_shipment(qty=1)
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh["name"])
		frappe.set_user(_manager(OTHER))
		with self.assertRaises(frappe.PermissionError):
			shipping.shipment(sh["name"])
		with self.assertRaises(frappe.PermissionError):
			inventory.receive_shipment(sh["name"])
		with self.assertRaises(frappe.PermissionError):
			shipping.wall()
		self.assertFalse(frappe.has_permission("Maison Shipment", "read", frappe.get_doc("Maison Shipment", sh["name"])))
		self.assertNotIn(sh["name"], frappe.get_list("Maison Shipment", pluck="name"))
		# `shipments()` must not leak the other store's consignment. Assert on *what* comes back
		# rather than on a global count: the suite runs on a shared site that already carries
		# shipments of this manager's own store from earlier runs (see INTEGRATION_NOTES v0.4 #13).
		visible = shipping.shipments("all")["shipments"]
		self.assertNotIn(sh["name"], [s["name"] for s in visible])
		self.assertEqual({s["boutique"] for s in visible} - {OTHER}, set())
		# nor the in-transit Stock Entries of the other store in the desk
		ship_se = frappe.get_doc("Stock Entry", frappe.db.get_value("Maison Shipment", sh["name"], "stock_entry_ship"))
		self.assertFalse(frappe.has_permission("Stock Entry", "read", ship_se))
		self.assertNotIn(ship_se.name, frappe.get_list("Stock Entry", pluck="name"))
		self.assertNotIn(sh["material_request"], frappe.get_list("Material Request", pluck="name"))
		# own store sees its own shipment and, once received, the In Transit → store leg
		frappe.set_user(_manager(STORE))
		self.assertEqual(shipping.shipment(sh["name"])["name"], sh["name"])
		self.assertIn(sh["name"], frappe.get_list("Maison Shipment", pluck="name"))
		recv = inventory.receive_shipment(sh["name"])
		recv_se = frappe.get_doc("Stock Entry", recv["stock_entry_receive"])
		self.assertTrue(frappe.has_permission("Stock Entry", "read", recv_se))
		self.assertIn(recv_se.name, frappe.get_list("Stock Entry", pluck="name"))
		self.assertIn(sh["material_request"], frappe.get_list("Material Request", pluck="name"))
		frappe.set_user(_manager(OTHER))
		self.assertFalse(frappe.has_permission("Stock Entry", "read", recv_se))

	def test_manager_cannot_request_into_another_store(self):
		frappe.set_user(_manager(OTHER))
		with self.assertRaises(frappe.PermissionError):
			inventory.replenish(STORE, lines=[{"item_code": ITEM, "qty": 1}])

	def test_warehouse_admin_cannot_sell_and_cannot_use_store_endpoints(self):
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.PermissionError):
			sales.submit_batch([pos_invoice(boutique=STORE)])
		with self.assertRaises(frappe.PermissionError):
			inventory.inbound(STORE)
		from maison_pos.scoping import assert_can_sell

		with self.assertRaises(frappe.PermissionError):
			assert_can_sell(STORE)
		# but may approve / see the wall
		self.assertIn("columns", shipping.wall())

	def test_selling_at_the_warehouse_boutique_is_refused(self):
		if not frappe.get_meta("Maison Boutique").has_field("is_warehouse"):
			self.skipTest("is_warehouse field not present on this seed")
		frappe.db.set_value("Maison Boutique", OTHER, "is_warehouse", 1)
		frappe.clear_document_cache("Maison Boutique", OTHER)
		frappe.set_user(_manager(OTHER))
		res = sales.submit_batch([pos_invoice(boutique=OTHER)])["results"][0]
		self.assertEqual((res["status"], res["error_code"]), ("error", sales.ERR_PERMISSION))

	# ------------------------------------------------------------------ rate adapters
	def test_simulated_rates_scale_with_zone_and_weight_and_pick_rules(self):
		p = SimulatedProvider()
		hou = {"city": "Houston", "state": "TX", "zip": "77098"}
		tulsa = {"city": "Tulsa", "state": "OK", "zip": "74133"}
		nyc = {"city": "New York", "state": "NY", "zip": "10001"}
		self.assertEqual(usps_zone(distance_miles(hou, tulsa)), 4)
		self.assertEqual(usps_zone(distance_miles(hou, nyc)), 7)
		self.assertEqual(usps_zone(distance_miles(hou, {"state": "TX", "zip": "773"})), 2)
		light = [{"length": 30, "width": 20, "height": 15, "weight": 0.8}]
		heavy = [{"length": 40, "width": 30, "height": 25, "weight": 9.0}]
		self.assertEqual(billable_lb(light), 4)  # 30×20×15 cm → 549 in³ / 139 = 3.95 → dim weight wins over 1.8 lb
		near = p.rates(hou, tulsa, light)
		far = p.rates(hou, nyc, light)
		big = p.rates(hou, tulsa, heavy)
		self.assertEqual([r.amount for r in near], sorted(r.amount for r in near))
		cheapest = pick_rate(near)
		fastest = pick_rate(near, "fastest")
		self.assertEqual(cheapest.provider_rate_id, near[0].provider_rate_id)
		self.assertIn(cheapest.service, ("Ground Advantage",))
		self.assertLessEqual(fastest.days, cheapest.days)
		self.assertGreater(fastest.amount, cheapest.amount)
		by_service = lambda rows: {(r.carrier, r.service): r.amount for r in rows}  # noqa: E731
		for key, amount in by_service(near).items():
			self.assertLess(amount, by_service(far)[key], key)
			self.assertLess(amount, by_service(big)[key], key)
		# realistic: a 2 lb Ground Advantage zone 4 parcel costs a few dollars, not cents or hundreds
		self.assertTrue(5 < by_service(near)[("USPS", "Ground Advantage")] < 15)
		label = p.buy(cheapest)
		self.assertTrue(label.tracking_no.startswith("9400") and len(label.tracking_no) == 22)
		with self.assertRaises(ShippingError):
			p.buy({"carrier": "UPS", "service": "Ground", "amount": 9, "days": 3, "provider_rate_id": "rate_xyz", "provider": "shippo"})

	def test_shippo_adapter_with_mocked_http(self):
		calls = []

		class R:
			def __init__(self, status, payload):
				self.status_code = status
				self._p = payload
				self.text = json.dumps(payload)

			def json(self):
				return self._p

		def fake_request(method, url, json=None, headers=None, timeout=None):
			calls.append((method, url, json, headers))
			if url.endswith("/shipments"):
				assert json["address_to"]["zip"] == "74133" and json["parcels"][0]["mass_unit"] == "lb"
				return R(201, {"status": "SUCCESS", "rates": [
					{"object_id": "rate_usps", "provider": "usps", "servicelevel": {"name": "Priority Mail"}, "amount": "9.87", "currency": "USD", "estimated_days": 2, "attributes": ["BESTVALUE"]},
					{"object_id": "rate_ups", "provider": "ups", "servicelevel": {"name": "Ground"}, "amount": "11.20", "currency": "USD", "estimated_days": 3, "attributes": []},
					{"object_id": "rate_fast", "provider": "fedex", "servicelevel": {"name": "Priority Overnight"}, "amount": "44.10", "currency": "USD", "estimated_days": 1, "attributes": ["FASTEST"]},
				]})
			if url.endswith("/transactions") and method == "POST":
				assert json["rate"] == "rate_usps"
				return R(201, {"object_id": "tx_1", "status": "QUEUED"})
			if url.endswith("/transactions/tx_1"):
				return R(200, {"object_id": "tx_1", "status": "SUCCESS", "label_url": "https://deliver.goshippo.com/label.pdf", "tracking_number": "9205590164917312751089", "tracking_url_provider": "https://tools.usps.com/x"})
			if "/tracks/usps/" in url:
				return R(200, {"tracking_status": {"status": "TRANSIT", "status_details": "Arrived at hub", "location": {"city": "Dallas", "state": "TX"}}, "eta": "2026-08-25T12:00:00Z", "tracking_history": [{"status": "PRE_TRANSIT", "status_date": "2026-08-22T10:00:00Z", "status_details": "Label created", "location": None}]})
			return R(400, {"detail": "bad request"})

		with patch("maison_pos.shipping.providers.shippo.requests.request", side_effect=fake_request):
			prov = ShippoProvider(api_key="shippo_test_abc")
			self.assertTrue(prov.test_mode)
			rates = prov.rates({"street1": "2037 W Alabama St", "city": "Houston", "state": "TX", "zip": "77098"}, {"street1": "11063-B S Memorial Dr", "city": "Tulsa", "state": "OK", "zip": "74133"}, [{"length": 40, "width": 30, "height": 25, "weight": 1.2}])
			self.assertEqual([r.provider_rate_id for r in rates], ["rate_usps", "rate_ups", "rate_fast"])
			self.assertEqual((rates[0].carrier, rates[0].service, rates[0].amount, rates[0].days), ("USPS", "Priority Mail", 9.87, 2))
			self.assertEqual(pick_rate(rates, "fastest").provider_rate_id, "rate_fast")
			self.assertEqual(calls[0][3]["Authorization"], "ShippoToken shippo_test_abc")
			label = prov.buy(rates[0], wait=0)
			self.assertEqual((label.tracking_no, label.label_url, label.provider), ("9205590164917312751089", "https://deliver.goshippo.com/label.pdf", "shippo"))
			t = prov.track("9205590164917312751089", "USPS")
			self.assertEqual((t.status, t.location), ("TRANSIT", "Dallas, TX"))
			self.assertEqual(len(t.events), 1)
			with self.assertRaises(ShippingError):
				prov._request("GET", "/nope")
		with self.assertRaises(ShippingError):
			ShippoProvider(api_key="")

	def test_shippo_end_to_end_through_the_api_with_mocked_http(self):
		sh = self._approved_shipment(qty=1)
		frappe.set_user(WH_ADMIN)

		def fake_request(method, url, json=None, headers=None, timeout=None):
			class R:
				status_code = 200

				def json(self_inner):
					if url.endswith("/shipments"):
						return {"status": "SUCCESS", "rates": [{"object_id": "rate_a", "provider": "usps", "servicelevel": {"name": "Ground Advantage"}, "amount": "7.10", "estimated_days": 3}]}
					return {"object_id": "tx_9", "status": "SUCCESS", "label_url": "https://deliver.goshippo.com/l.pdf", "tracking_number": "9400111111111111111111", "tracking_url_provider": "https://tools.usps.com/y"}

				text = ""

			return R()

		with patch("maison_pos.shipping.providers.shippo.requests.request", side_effect=fake_request), patch.dict(frappe.conf, {"shippo_api_key": "shippo_test_xyz"}):
			quote = shipping.rates(sh["name"], provider="shippo")
			self.assertEqual(quote["provider"], "shippo")
			bought = shipping.buy(sh["name"], "rate_a")
		self.assertEqual((bought["provider"], bought["carrier"], bought["tracking_no"], bought["rate_amount"]), ("shippo", "USPS", "9400111111111111111111", 7.1))
		self.assertEqual(bought["label_url"], "https://deliver.goshippo.com/l.pdf")

	# ------------------------------------------------------------------ vendor PO at the warehouse
	def test_warehouse_admin_receives_vendor_po_at_main_warehouse(self):
		wh = _source_warehouse()
		company = frappe.db.get_value("Warehouse", wh, "company")
		if not frappe.db.exists("Supplier", "Test Vape Distro"):
			frappe.get_doc({"doctype": "Supplier", "supplier_name": "Test Vape Distro", "supplier_group": frappe.db.get_value("Supplier Group", {"is_group": 0}, "name") or "All Supplier Groups"}).insert(ignore_permissions=True)
		po = frappe.get_doc({"doctype": "Purchase Order", "supplier": "Test Vape Distro", "company": company, "transaction_date": nowdate(), "schedule_date": nowdate(), "set_warehouse": wh, "items": [{"item_code": ITEM2, "qty": 10, "rate": 12, "schedule_date": nowdate(), "warehouse": wh}]})
		po.flags.ignore_permissions = True
		po.insert()
		po.submit()
		frappe.set_user(WH_ADMIN)
		self.assertIn(po.name, [p["name"] for p in shipping.vendor_pos()["purchase_orders"]])
		before = _bin(ITEM2, wh)
		out = shipping.receive_vendor_po(po.name, lines=[{"item_code": ITEM2, "qty": 6}])
		self.assertEqual(frappe.db.get_value("Purchase Receipt", out["purchase_receipt"], "docstatus"), 1)
		self.assertEqual(_bin(ITEM2, wh), before + 6)
		self.assertAlmostEqual(flt(frappe.db.get_value("Purchase Order", po.name, "per_received")), 60.0)
		# a store manager cannot receive a PO addressed to the warehouse
		frappe.set_user(_manager(STORE))
		with self.assertRaises(frappe.PermissionError):
			inventory.receive_po(po.name, lines=[{"item_code": ITEM2, "qty": 1}])

	def test_packing_list_renders_with_barcodes_and_qr(self):
		sh = self._approved_shipment(qty=2)
		frappe.set_user("Administrator")
		html = frappe.get_print("Maison Shipment", sh["name"], "Maison Packing List", no_letterhead=1)
		self.assertIn(sh["name"], html)
		self.assertIn("MSH:" + sh["name"], html)
		self.assertIn("data:image/svg+xml;base64", html)
		self.assertIn(STORE, html)
		self.assertIn("Packing list", html)
