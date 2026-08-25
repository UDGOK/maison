"""v1.1 — the **owner / developer seat** (:mod:`maison_pos.setup.owner`).

Every other account on this platform is fenced: a store manager sees one store, a regional a
region, the warehouse admin buys but does not sell. That fencing is what makes the audit trail
worth reading — and it means somebody has to hold the one seat that is *not* fenced: the person
who builds and supports the platform. ``setup.owner`` creates exactly that account, as a **named**
user rather than a shared ``Administrator``, so every line it writes into the audit log still says
who did it.

What these tests pin down:

* the grant — every role in :data:`~maison_pos.setup.owner.OWNER_ROLES` plus whichever of
  :data:`~maison_pos.setup.owner.ERPNEXT_ROLES` the site actually has, and a second run that adds
  nothing (:class:`TestCreatingTheSeat`);
* the load-bearing claim, **no ``User Permission``**, proved behaviourally rather than by counting
  rows. Scoping in this app is applied by User Permission rows, so *unrestricted* has to mean the
  owner reads a store's documents that a store manager is refused; and one User Permission is
  enough to blind even this seat, which is why ``create_owner`` takes them off
  (:class:`TestTheSeatIsUnrestricted`, and over real sessions in :class:`TestTheSeatOverHTTP`);
* the till identity — an ``AWANZ Associate`` row with the *HeadOffice* role and **no store**, so
  the owner can unlock a till anywhere (:class:`TestTheTillIdentity`);
* the password — optional, never in the returned payload, and, when one is passed, good enough to
  sign in with over the wire (:class:`TestThePassword`, :class:`TestTheSeatOverHTTP`);
* revocation — disabled and **not** deleted, because the audit trail refers to this user and a
  deleted one turns every reference into a dangling name; and refused at the login form afterwards
  (:class:`TestRevokingTheSeat`, :class:`TestTheSeatOverHTTP`).

:class:`TestThePasswordPolicy` answers the question a strict site raises: a weak password is
refused **out loud** by Frappe's own policy, and no account is left behind claiming a password it
does not have. That check is switched off by ``frappe.flags.in_test`` (``User.validate``), so the
test puts the flag back to run it for real.

No password literal appears in this file: :func:`throwaway_password` invents one per run. The HTTP
class is skipped when the site is not being served (CI without ``bench start``).
"""

from __future__ import annotations

import json
import re
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase, change_settings
from frappe.utils.password import check_password

from maison_pos.api import inventory
from maison_pos.api import shipping as shipping_api
from maison_pos.setup.owner import ERPNEXT_ROLES, OWNER_ROLES, create_owner, revoke_owner
from maison_pos.tests.helpers import ensure_demo_data

#: two stores, and the demo manager of the first one — who must never reach the second
STORE_A, STORE_B = "NYC-5AV", "CHI-OAK"
ITEM = "AC-012"
#: the demo users' password, as in the other HTTP suites
PWD = "maison123"
#: a PIN is four to six digits by contract — a till secret, not a password
OWNER_PIN = "4821"
#: stamped on the one committed document the HTTP class raises, so a run that is killed before its
#: teardown can be tidied up by the next one
HTTP_REQUEST_REASON = "v1.1 owner seat http"


def throwaway_password() -> str:
	"""A password this run invents and throws away.

	Never a literal. A real password must not exist in this repository, and a test one that looks
	like a real one is the thing somebody copies into a client's site.
	"""
	return "Awz-" + frappe.generate_hash(length=24) + "-7Q"


def auth_rows(email: str) -> list:
	"""The ``__Auth`` password rows for *email* — empty means no password was ever set."""
	return list(
		frappe.db.sql(
			"select name from `__Auth` where doctype = 'User' and name = %s and fieldname = 'password'",
			email,
		)
	)


def held_roles(email: str) -> set[str]:
	"""The roles actually on the User record (not ``frappe.get_roles``, which adds implicit ones)."""
	return set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))


def erpnext_roles_on_this_site() -> set[str]:
	return {role for role in ERPNEXT_ROLES if frappe.db.exists("Role", role)}


def fence(email: str, boutique: str) -> str:
	"""Fence *email* to one store with a ``User Permission`` — how a real deployment scopes anyone.

	The same call ``test_v1_1_role_permissions.fence_to_region`` makes: this is the mechanism the
	owner seat is defined by the *absence* of.
	"""
	perm = frappe.get_doc(
		{
			"doctype": "User Permission",
			"user": email,
			"allow": "AWANZ Store",
			"for_value": boutique,
			"apply_to_all_doctypes": 1,
		}
	)
	perm.flags.ignore_permissions = True
	perm.insert()
	frappe.clear_cache(user=email)
	return perm.name


def forget(email: str) -> None:
	"""Remove an owner seat and everything hung off it — for the committed HTTP fixtures only."""
	if frappe.db.exists("AWANZ Associate", email):
		frappe.delete_doc("AWANZ Associate", email, force=True, ignore_permissions=True, delete_permanently=True)
	frappe.db.delete("User Permission", {"user": email})
	for contact in frappe.get_all("Contact", filters={"user": email}, pluck="name"):
		frappe.delete_doc("Contact", contact, force=True, ignore_permissions=True, delete_permanently=True)
	if frappe.db.exists("User", email):
		frappe.delete_doc("User", email, force=True, ignore_permissions=True, delete_permanently=True)
	frappe.clear_cache(user=email)


class OwnerSeatCase(FrappeTestCase):
	"""Each test names its own seat, so tests in one class cannot stand on each other's account.

	``FrappeTestCase`` rolls back once per class, not once per test — see
	``frappe.tests.utils.FrappeTestCase.setUpClass`` — so everything written here disappears when
	the class finishes and nothing is committed.
	"""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	def seat(self, tag: str) -> str:
		return f"v11.owner.{tag}@awanz.test"


# ---------------------------------------------------------------------------------------------
class TestCreatingTheSeat(OwnerSeatCase):
	"""The grant, and running it a second time."""

	def test_the_owner_holds_every_owner_role_and_the_erpnext_roles_this_site_has(self):
		email = self.seat("roles")
		out = create_owner(email, first_name="Owner", last_name="Seat")
		self.assertTrue(out["created"])
		self.assertEqual(out["user"], email)

		wanted = set(OWNER_ROLES) | erpnext_roles_on_this_site()
		self.assertTrue(erpnext_roles_on_this_site(), "this site has no ERPNext roles at all — check the fixture")
		self.assertEqual(set(OWNER_ROLES) - held_roles(email), set(), "an owner must hold every role in OWNER_ROLES")
		# exactly the wanted set: nothing missing, and nothing granted that was not asked for
		self.assertEqual(held_roles(email), wanted)
		self.assertEqual(set(out["roles"]), wanted)
		self.assertEqual(frappe.db.get_value("User", email, "user_type"), "System User")
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 1)

	def test_a_role_this_site_does_not_have_is_skipped_rather_than_failing_the_call(self):
		"""``ERPNEXT_ROLES`` is a wish list: the module has to run on a site without ERPNext's
		buying or accounting modules, so a missing role is skipped and never throws."""
		email = self.seat("missing.role")
		out = create_owner(email)
		self.assertEqual(set(out["roles"]) - erpnext_roles_on_this_site() - set(OWNER_ROLES), set())
		for role in ERPNEXT_ROLES:
			if not frappe.db.exists("Role", role):
				self.assertNotIn(role, out["roles"])

	def test_the_associate_row_does_not_take_the_other_awanz_roles_back_off(self):
		"""The regression the seat was written past.

		``AWANZ Associate.on_update`` syncs the User's ``AWANZ *`` role from its own ``role`` field
		and **removes the other three** (v0.7 S5 — ``awanz_associate._sync_user_role``). Written
		after the grant, that row stripped ``AWANZ Associate`` / ``AWANZ Manager`` /
		``AWANZ Regional`` straight off a brand-new owner, and only a *second* run put them back.
		"""
		email = self.seat("role.sync")
		out = create_owner(email)
		self.assertEqual(frappe.db.get_value("AWANZ Associate", email, "role"), "HeadOffice")
		for role in ("AWANZ Associate", "AWANZ Manager", "AWANZ Regional", "AWANZ Head Office"):
			self.assertIn(role, out["roles"], f"{role} was taken back off by the associate role sync")
			self.assertIn(role, held_roles(email), f"{role} was taken back off by the associate role sync")

	def test_running_it_twice_adds_nothing_and_breaks_nothing(self):
		email = self.seat("twice")
		first = create_owner(email, first_name="Owner", last_name="Seat")
		before = held_roles(email)

		second = create_owner(email, first_name="Owner", last_name="Seat")
		self.assertFalse(second["created"])
		self.assertEqual(second["roles_added"], [], "a second run must have nothing left to add")
		self.assertEqual(held_roles(email), before)
		self.assertEqual(second["roles"], first["roles"])
		self.assertEqual(second["associate"], first["associate"])
		self.assertEqual(frappe.db.count("AWANZ Associate", {"user": email}), 1, "one till identity, not two")
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 1)
		self.assertEqual(second["user_permissions_removed"], 0)

	def test_a_bad_email_is_refused_and_creates_nothing(self):
		before = frappe.db.count("User")
		for bad in (None, "", "   ", "not-an-email", "owner", "owner.example.com"):
			with self.assertRaises(frappe.ValidationError, msg=f"{bad!r} was accepted as an owner address"):
				create_owner(bad)
		self.assertEqual(frappe.db.count("User"), before, "a refused address must not leave a User behind")

	def test_the_address_is_normalised_before_anything_is_written(self):
		"""``  Owner@Example.COM  `` and ``owner@example.com`` are one seat, not two."""
		email = self.seat("case")
		create_owner(f"  {email.upper()}  ")
		self.assertTrue(frappe.db.exists("User", email))
		out = create_owner(email)
		self.assertFalse(out["created"], "the same address in another case must not make a second seat")


# ---------------------------------------------------------------------------------------------
class TestTheSeatIsUnrestricted(OwnerSeatCase):
	"""The load-bearing claim: **no ``User Permission``**, proved by what the seat can read.

	Counting rows would prove nothing on its own — what matters is that the absence of those rows
	is *why* the owner reads what a fenced account cannot. So each test here compares the owner
	against the demo store manager of ``STORE_A`` on a document that belongs to ``STORE_B``.
	"""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.set_user("Administrator")
		cls.manager = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "user")
		if not cls.manager:
			raise unittest.SkipTest(f"demo manager for {STORE_A} missing")
		cls.request_b = shipping_api.create_request(STORE_B, [{"item_code": ITEM, "qty": 1}], reason="v1.1 owner seat").name

	def test_the_owner_reads_a_store_document_the_manager_of_another_store_cannot(self):
		email = self.seat("reads")
		create_owner(email)
		frappe.clear_cache(user=email)
		other_store_request = frappe.get_doc("AWANZ Replenishment Request", self.request_b)

		self.assertEqual(frappe.get_all("User Permission", filters={"user": email}, pluck="name"), [])
		self.assertTrue(frappe.has_permission("AWANZ Replenishment Request", "read", doc=other_store_request, user=email))
		self.assertTrue(frappe.has_permission("AWANZ Store", "read", doc=STORE_B, user=email))
		# the same two documents, for somebody the User Permission rows do fence
		self.assertTrue(frappe.get_all("User Permission", filters={"user": self.manager}, pluck="name"))
		self.assertFalse(frappe.has_permission("AWANZ Replenishment Request", "read", doc=other_store_request, user=self.manager))
		self.assertFalse(frappe.has_permission("AWANZ Store", "read", doc=STORE_B, user=self.manager))

	def test_one_user_permission_blinds_even_this_seat_and_the_re_run_takes_it_off(self):
		"""Why the removal is load-bearing and not housekeeping.

		``System Manager`` does not buy past a User Permission: Frappe's row-level layer applies to
		whoever holds the row. Fence the owner to one store and the rest of the chain goes dark, so
		an owner seat is only unrestricted for as long as it carries none.
		"""
		email = self.seat("fenced")
		create_owner(email)
		other_store_request = frappe.get_doc("AWANZ Replenishment Request", self.request_b)
		frappe.clear_cache(user=email)
		self.assertTrue(frappe.has_permission("AWANZ Store", "read", doc=STORE_B, user=email))

		fence(email, STORE_A)
		self.assertFalse(frappe.has_permission("AWANZ Store", "read", doc=STORE_B, user=email), "the fence must bite")
		self.assertFalse(frappe.has_permission("AWANZ Replenishment Request", "read", doc=other_store_request, user=email))

		out = create_owner(email)
		self.assertEqual(out["user_permissions_removed"], 1)
		self.assertEqual(frappe.get_all("User Permission", filters={"user": email}, pluck="name"), [])
		frappe.clear_cache(user=email)
		self.assertTrue(frappe.has_permission("AWANZ Store", "read", doc=STORE_B, user=email))
		self.assertTrue(frappe.has_permission("AWANZ Replenishment Request", "read", doc=other_store_request, user=email))

	def test_every_user_permission_goes_not_merely_the_first(self):
		email = self.seat("many.fences")
		create_owner(email)
		fence(email, STORE_A)
		fence(email, STORE_B)
		self.assertEqual(len(frappe.get_all("User Permission", filters={"user": email})), 2)
		out = create_owner(email)
		self.assertEqual(out["user_permissions_removed"], 2)
		self.assertEqual(frappe.get_all("User Permission", filters={"user": email}, pluck="name"), [])

	def test_the_seat_is_named_so_the_audit_trail_says_who(self):
		"""The whole argument against sharing ``Administrator``, as a test.

		The owner acts on a store they have no ``AWANZ Associate`` attachment to, and the document
		carries *their* name — which a shared unnamed superuser could not have left behind.
		"""
		email = self.seat("audit")
		create_owner(email, first_name="Owner", last_name="Seat")
		frappe.clear_cache(user=email)
		frappe.set_user(email)
		out = inventory.replenish(boutique=STORE_B, lines=[{"item_code": ITEM, "qty": 1}], reason="v1.1 owner seat")
		frappe.set_user("Administrator")
		row = frappe.db.get_value("AWANZ Replenishment Request", out["name"], ["owner", "requested_by", "boutique"], as_dict=True)
		self.assertEqual(row.boutique, STORE_B)
		self.assertEqual(row.owner, email)
		self.assertEqual(row.requested_by, email)
		self.assertNotEqual(row.owner, "Administrator")


# ---------------------------------------------------------------------------------------------
class TestTheTillIdentity(OwnerSeatCase):
	"""The ``AWANZ Associate`` row: *HeadOffice*, and no store, so no till is out of reach."""

	def test_the_associate_row_is_head_office_with_no_store(self):
		email = self.seat("till")
		out = create_owner(email, pin=OWNER_PIN)
		self.assertEqual(out["associate"], email)
		row = frappe.db.get_value("AWANZ Associate", out["associate"], ["user", "role", "boutique", "enabled"], as_dict=True)
		self.assertEqual(row.user, email)
		self.assertEqual(row.role, "HeadOffice")
		self.assertIsNone(row.boutique, "a store on this row would pin the owner to that one till")
		self.assertEqual(row.enabled, 1)

	def test_the_store_less_row_unlocks_a_till_anywhere(self):
		"""Behaviourally: the PIN verifies, and the answer carries no store to check it against.

		``awanz_associate.verify_pin`` narrows to ``assert_boutique_access(doc.boutique)`` when the
		row names a store; with none it falls through to the unrestricted branch, which is exactly
		what lets this one identity unlock a till in any of them.
		"""
		from maison_pos.awanz_pos.doctype.awanz_associate.awanz_associate import verify_pin

		email = self.seat("unlock")
		out = create_owner(email, pin=OWNER_PIN)
		frappe.clear_cache(user=email)
		frappe.set_user(email)
		answer = verify_pin(out["associate"], OWNER_PIN)
		self.assertTrue(answer["ok"])
		self.assertEqual(answer["role"], "HeadOffice")
		self.assertIsNone(answer["boutique"])
		self.assertFalse(verify_pin(out["associate"], "0123")["ok"], "a wrong PIN must still be a wrong PIN")

	def test_the_clear_text_pin_is_never_kept(self):
		email = self.seat("pin.storage")
		out = create_owner(email, pin=OWNER_PIN)
		row = frappe.db.get_value("AWANZ Associate", out["associate"], ["pin", "pin_hash"], as_dict=True)
		self.assertFalse(row.pin, "the clear-text PIN must not survive the save")
		self.assertNotIn(OWNER_PIN, str(row.pin_hash or ""))

	def test_an_owner_created_without_a_pin_gets_a_random_one_shown_once(self):
		"""It used to fall back to ``0000``.

		A seat created by the documented one-liner unlocked every till in the chain with four
		zeros — and unlike the account password, a till PIN is typed in front of customers. Now a
		random six-digit PIN is generated and returned **once**, so there is something to write
		down and nothing to guess.
		"""
		from maison_pos.awanz_pos.doctype.awanz_associate.awanz_associate import verify_pin

		email = self.seat("generated.pin")
		out = create_owner(email)
		pin = out["till_pin"]
		self.assertIsNotNone(pin, "a seat created without a PIN must be handed a generated one")
		self.assertRegex(pin, r"^\d{6}$")
		self.assertNotIn(pin, ("000000", "0000"))
		frappe.set_user(email)
		self.assertTrue(verify_pin(out["associate"], pin)["ok"])
		self.assertFalse(verify_pin(out["associate"], "0000")["ok"], "0000 must no longer open a till")

	def test_a_pin_that_was_asked_for_is_used_and_nothing_is_generated(self):
		from maison_pos.awanz_pos.doctype.awanz_associate.awanz_associate import verify_pin

		email = self.seat("chosen.pin")
		out = create_owner(email, pin="481902")
		self.assertIsNone(out["till_pin"], "nothing is generated when the caller chose one")
		frappe.set_user(email)
		self.assertTrue(verify_pin(out["associate"], "481902")["ok"])

	def test_a_re_run_does_not_mint_a_second_pin_for_an_existing_seat(self):
		email = self.seat("stable.pin")
		first = create_owner(email)
		again = create_owner(email)
		self.assertIsNotNone(first["till_pin"])
		self.assertIsNone(again["till_pin"], "the seat already has a PIN; do not silently replace it")

	def test_a_re_run_re_enables_a_disabled_till_identity(self):
		email = self.seat("reenable")
		out = create_owner(email)
		revoke_owner(email)
		self.assertEqual(frappe.db.get_value("AWANZ Associate", out["associate"], "enabled"), 0)
		create_owner(email)
		self.assertEqual(frappe.db.get_value("AWANZ Associate", out["associate"], "enabled"), 1)
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 1)


# ---------------------------------------------------------------------------------------------
class TestThePassword(OwnerSeatCase):
	"""Optional at creation, never in the payload, never in this repository."""

	def test_password_none_sets_no_password_and_does_not_fail(self):
		email = self.seat("no.password")
		out = create_owner(email)  # password defaults to None
		self.assertFalse(out["password_set"])
		self.assertEqual(auth_rows(email), [], "no password may be stored when none was asked for")
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 1, "the account is made either way")
		with self.assertRaises(frappe.AuthenticationError):
			check_password(email, throwaway_password())

	def test_a_password_that_is_passed_is_hashed_and_authenticates(self):
		email = self.seat("password")
		password = throwaway_password()
		out = create_owner(email, password=password)
		self.assertTrue(out["password_set"])
		self.assertEqual(check_password(email, password), email)
		with self.assertRaises(frappe.AuthenticationError):
			check_password(email, password + "-wrong")
		stored = auth_rows(email)
		self.assertTrue(stored, "the hash has to be somewhere")

	def test_the_returned_payload_never_carries_the_password(self):
		email = self.seat("payload")
		password = throwaway_password()

		created = create_owner(email, password=password)
		self.assertNotIn(password, json.dumps(created, default=str), "the create payload leaked the password")
		self.assertNotIn("password", set(created) - {"password_set"})
		self.assertIs(created["password_set"], True, "it says *that* one was set, never what it was")

		again = create_owner(email, password=password)
		self.assertNotIn(password, json.dumps(again, default=str), "the re-run payload leaked the password")
		self.assertNotIn("password", set(again) - {"password_set"})

	def test_the_clear_text_password_is_not_left_on_the_user_record(self):
		email = self.seat("clear.text")
		password = throwaway_password()
		create_owner(email, password=password)
		self.assertFalse(frappe.db.get_value("User", email, "new_password"), "`new_password` must be cleared on save")
		row = frappe.db.get_value("User", email, ["new_password", "first_name", "last_name"], as_dict=True)
		self.assertNotIn(password, json.dumps(row, default=str))

	def test_a_re_run_without_a_password_leaves_the_existing_one_alone(self):
		"""Topping the seat up must not lock the owner out of it."""
		email = self.seat("keep.password")
		password = throwaway_password()
		create_owner(email, password=password)
		out = create_owner(email)
		self.assertFalse(out["password_set"])
		self.assertEqual(check_password(email, password), email)


# ---------------------------------------------------------------------------------------------
class TestThePasswordPolicy(OwnerSeatCase):
	"""What a strict site does with a weak password — the failure has to be loud.

	``create_owner`` sets ``user.flags.ignore_password_policy = False``, so Frappe's own policy
	applies to whatever the operator passes. The dangerous outcome would be a *silent* one: an
	account saved without the password its operator believes they set, who then cannot log in and
	has nothing to read about why. It is not silent — ``User.password_strength_test`` throws — but
	the suite runs with ``frappe.flags.in_test`` set, and that is the exact flag ``User.validate``
	checks before running the policy at all, so these tests put it back.
	"""

	def as_a_real_site(self) -> None:
		"""Drop ``frappe.flags.in_test`` for the rest of this test, then put it back."""
		was = frappe.flags.in_test
		self.addCleanup(setattr, frappe.flags, "in_test", was)
		frappe.flags.in_test = False

	def test_a_weak_password_under_a_strict_policy_is_refused_out_loud(self):
		email = self.seat("policy")
		create_owner(email, first_name="Policy")  # the seat exists, with no password yet
		with change_settings("System Settings", enable_password_policy=1, minimum_password_score=4):
			self.as_a_real_site()
			with self.assertRaises(frappe.ValidationError) as caught:
				create_owner(email, password="abc")
		self.assertTrue(str(caught.exception).strip(), "a refusal the operator cannot read is not a refusal")
		self.assertTrue(
			any("password" in str(entry.get("title", "")).lower() for entry in frappe.message_log),
			f"nothing in the message log names the password: {frappe.message_log}",
		)

	def test_the_refused_password_is_not_quietly_saved_anyway(self):
		"""The trap this class exists to rule out: an operator who thinks they set a password."""
		email = self.seat("policy.not.saved")
		create_owner(email, first_name="Policy")
		with change_settings("System Settings", enable_password_policy=1, minimum_password_score=4):
			self.as_a_real_site()
			with self.assertRaises(frappe.ValidationError):
				create_owner(email, password="abc")
		self.assertEqual(auth_rows(email), [], "the refused password must not be stored")
		with self.assertRaises(frappe.AuthenticationError):
			check_password(email, "abc")

	def test_the_brand_new_seat_is_refused_on_the_same_save(self):
		"""The documented one-liner creates the account and sets the password in one call.

		The refusal lands on the same ``user.save()``, *after* the ``User`` row is inserted, so it
		is the caller's transaction that has to be discarded — which is what ``bench execute``
		does, since a method that raises never reaches its commit. A caller that commits on its own
		would keep a passwordless account and should re-run with a password the policy accepts.
		"""
		email = self.seat("policy.new")
		with change_settings("System Settings", enable_password_policy=1, minimum_password_score=4):
			self.as_a_real_site()
			with self.assertRaises(frappe.ValidationError):
				create_owner(email, password="abc")
		self.assertEqual(auth_rows(email), [], "no password was stored for the refused seat")

	def test_the_same_strict_policy_accepts_the_password_this_suite_generates(self):
		"""So the sign-in tests are not passing because this site's policy happens to be lax."""
		from frappe.core.doctype.user.user import test_password_strength as password_strength

		with change_settings("System Settings", enable_password_policy=1, minimum_password_score=4):
			result = password_strength(throwaway_password())
		self.assertTrue(result["feedback"]["password_policy_validation_passed"], result)


# ---------------------------------------------------------------------------------------------
class TestRevokingTheSeat(OwnerSeatCase):
	"""Handing the platform over: disable the seat, keep the name the audit trail points at."""

	def test_revoke_disables_the_user_and_the_till_identity(self):
		email = self.seat("revoke")
		out = create_owner(email, password=throwaway_password(), pin=OWNER_PIN)
		self.assertEqual(revoke_owner(email), {"user": email, "enabled": False})
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 0)
		self.assertEqual(frappe.db.get_value("AWANZ Associate", out["associate"], "enabled"), 0)

	def test_revoke_deletes_neither_so_the_audit_trail_still_resolves(self):
		"""A deleted user turns every reference in the audit trail into a dangling name."""
		email = self.seat("revoke.keeps")
		out = create_owner(email)
		frappe.clear_cache(user=email)
		frappe.set_user(email)
		request = inventory.replenish(boutique=STORE_B, lines=[{"item_code": ITEM, "qty": 1}], reason="v1.1 owner seat")["name"]
		frappe.set_user("Administrator")

		revoke_owner(email)
		self.assertTrue(frappe.db.exists("User", email), "the user must survive revocation")
		self.assertTrue(frappe.db.exists("AWANZ Associate", out["associate"]), "the till identity must survive it too")
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", request, "owner"), email)
		self.assertTrue(frappe.db.get_value("User", email, "full_name"), "the name behind the audit entry still reads")
		# the roles are left where they are: what is revoked is signing in, not who this was
		self.assertIn("System Manager", held_roles(email))

	def test_a_revoked_seat_keeps_its_password_but_cannot_use_it(self):
		email = self.seat("revoke.password")
		password = throwaway_password()
		create_owner(email, password=password)
		revoke_owner(email)
		self.assertEqual(check_password(email, password), email, "the hash is untouched")
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 0, "…and disabled is what stops the login")

	def test_revoking_somebody_who_is_not_a_user_here_is_refused(self):
		with self.assertRaises(frappe.DoesNotExistError):
			revoke_owner(self.seat("never.existed"))

	def test_revoke_normalises_the_address_the_same_way(self):
		email = self.seat("revoke.case")
		create_owner(email)
		revoke_owner(f"  {email.upper()}  ")
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 0)


# ---------------------------------------------------------------------------------------------
def _base_url() -> str:
	port = frappe.conf.get("webserver_port") or 8000
	return f"http://127.0.0.1:{port}"


def _alive(base: str) -> bool:
	try:
		r = requests.get(f"{base}/api/method/frappe.ping", headers={"Host": frappe.local.site}, timeout=3)
		return r.ok and r.json().get("message") == "pong"
	except Exception:
		return False


class Client:
	"""Minimal session client: login, then GET / POST ``/api/method/<m>`` with CSRF."""

	def __init__(self, base: str, site: str, user: str, pwd: str):
		self.s = requests.Session()
		self.s.headers["Host"] = site
		self.base = base
		r = self.s.post(f"{base}/api/method/login", json={"usr": user, "pwd": pwd}, timeout=15)
		assert r.ok, f"login {user}: {r.status_code} {r.text[:200]}"
		page = self.s.get(f"{base}/pos", timeout=15).text
		m = re.search(r'window\.csrf_token = "([^"]*)"', page)
		self.csrf = m.group(1) if m else ""

	def get(self, method: str, /, **params):
		return self.s.get(f"{self.base}/api/method/{method}", params=params, timeout=30)

	def post(self, method: str, /, **data):
		return self.s.post(f"{self.base}/api/method/{method}", json=data, headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=30)


def login_refused(base: str, user: str, pwd: str):
	"""A login attempt that is *expected* to fail, without the assert :class:`Client` makes."""
	return requests.post(f"{base}/api/method/login", json={"usr": user, "pwd": pwd}, headers={"Host": frappe.local.site}, timeout=15)


class TestTheSeatOverHTTP(FrappeTestCase):
	"""The seat against the running bench: real logins, real sessions, real ``/api/method`` calls.

	The web workers write on their own connections and cannot see this one's transaction, so the
	fixtures here are **committed** and taken away again in ``tearDownClass`` — the same shape as
	``test_v1_0_purchasing_http`` and ``test_v1_1_role_permissions_http``.
	"""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — the owner HTTP tests need `bench start`")
		ensure_demo_data()
		frappe.set_user("Administrator")
		cls.manager = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "user")
		if not cls.manager:
			raise unittest.SkipTest(f"demo manager for {STORE_A} missing")

		cls.email = "v11.owner.http@awanz.test"
		cls.handover = "v11.owner.handover@awanz.test"
		cls.password = throwaway_password()
		cls.handover_password = throwaway_password()
		# a previous run that was killed before its teardown left its committed fixtures behind
		forget(cls.email)
		forget(cls.handover)
		cls._drop_stale_requests()
		create_owner(cls.email, password=cls.password, first_name="Owner", last_name="Seat")
		create_owner(cls.handover, password=cls.handover_password, first_name="Handover", last_name="Seat")
		cls.request_b = shipping_api.create_request(STORE_B, [{"item_code": ITEM, "qty": 1}], reason=HTTP_REQUEST_REASON).name
		frappe.db.commit()

	@classmethod
	def _drop_stale_requests(cls) -> None:
		for name in frappe.get_all("AWANZ Replenishment Request", filters={"reason": HTTP_REQUEST_REASON}, pluck="name"):
			frappe.delete_doc("AWANZ Replenishment Request", name, force=True, ignore_permissions=True, delete_permanently=True)

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		try:
			cls._drop_stale_requests()
			forget(cls.email)
			forget(cls.handover)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v1.1 owner seat http cleanup")
		super().tearDownClass()

	def client(self, user: str, pwd: str) -> Client:
		return Client(self.base, frappe.local.site, user, pwd)

	def test_the_owner_reads_a_store_document_the_manager_is_refused(self):
		"""The load-bearing claim over the wire, both directions on the same two documents."""
		owner_client = self.client(self.email, self.password)
		manager = self.client(self.manager, PWD)
		self.assertEqual(frappe.get_all("User Permission", filters={"user": self.email}, pluck="name"), [])

		for doctype, name in (("AWANZ Replenishment Request", self.request_b), ("AWANZ Store", STORE_B)):
			r = owner_client.get("frappe.client.get", doctype=doctype, name=name)
			self.assertEqual(r.status_code, 200, f"the owner must read {doctype} {name}: {r.text[:200]}")
			self.assertEqual(r.json()["message"]["name"], name)
			r = manager.get("frappe.client.get", doctype=doctype, name=name)
			self.assertEqual(r.status_code, 403, f"a {STORE_A} manager must not read {doctype} {name}: {r.text[:200]}")

		# …and the list surface agrees with the document surface
		r = owner_client.get("frappe.client.get_list", doctype="AWANZ Replenishment Request", fields='["name"]', limit_page_length=0)
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertIn(self.request_b, [row["name"] for row in r.json()["message"]])
		r = manager.get("frappe.client.get_list", doctype="AWANZ Replenishment Request", fields='["name"]', limit_page_length=0)
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertNotIn(self.request_b, [row["name"] for row in r.json()["message"]])

	def test_one_user_permission_blinds_the_seat_over_http_and_the_re_run_frees_it(self):
		"""Fence, go blind, re-run, see again — each check on its own fresh session."""
		self.addCleanup(self._unfence)
		before = self.client(self.email, self.password)
		self.assertEqual(before.get("frappe.client.get", doctype="AWANZ Store", name=STORE_B).status_code, 200)

		fence(self.email, STORE_A)
		frappe.db.commit()
		frappe.clear_cache(user=self.email)
		fenced = self.client(self.email, self.password)
		r = fenced.get("frappe.client.get", doctype="AWANZ Store", name=STORE_B)
		self.assertEqual(r.status_code, 403, f"one User Permission must fence even this seat: {r.text[:200]}")

		out = create_owner(self.email)
		self.assertEqual(out["user_permissions_removed"], 1)
		frappe.db.commit()
		frappe.clear_cache(user=self.email)
		freed = self.client(self.email, self.password)
		r = freed.get("frappe.client.get", doctype="AWANZ Store", name=STORE_B)
		self.assertEqual(r.status_code, 200, f"the seat must be unrestricted again: {r.text[:200]}")

	def _unfence(self) -> None:
		frappe.db.delete("User Permission", {"user": self.email})
		frappe.db.commit()
		frappe.clear_cache(user=self.email)

	def test_the_password_passed_at_creation_signs_in_and_reaches_a_gated_endpoint(self):
		owner_client = self.client(self.email, self.password)
		self.assertEqual(owner_client.get("frappe.auth.get_logged_user").json()["message"], self.email)

		r = owner_client.get("maison_pos.api.purchasing.vendors")
		self.assertEqual(r.status_code, 200, f"the owner must reach purchasing: {r.text[:300]}")
		# the same endpoint is shut to a store manager, so a 200 is the seat and not an open door
		manager = self.client(self.manager, PWD)
		self.assertEqual(manager.get("maison_pos.api.purchasing.vendors").status_code, 403)

		refused = login_refused(self.base, self.email, self.password + "-wrong")
		self.assertEqual(refused.status_code, 401, "any password but the one that was set must be refused")

	def test_a_revoked_owner_can_no_longer_sign_in(self):
		# it signs in first, so the refusal afterwards is the revocation and not a bad fixture
		open_session = self.client(self.handover, self.handover_password)
		self.assertEqual(open_session.get("maison_pos.api.purchasing.vendors").status_code, 200)

		revoke_owner(self.handover, commit=True)
		frappe.clear_cache(user=self.handover)
		refused = login_refused(self.base, self.handover, self.handover_password)
		self.assertEqual(refused.status_code, 401, f"a revoked owner signed in: {refused.status_code} {refused.text[:200]}")

		# the browser the developer already had open dies with it — a handover that only takes
		# effect at the next login is not a handover
		r = open_session.get("maison_pos.api.purchasing.vendors")
		self.assertNotEqual(r.status_code, 200, f"the session opened before revocation still works: {r.text[:200]}")
		self.assertIn("disabled", r.text.lower(), r.text[:300])

		# disabled, never deleted — the audit trail still resolves the name
		self.assertTrue(frappe.db.exists("User", self.handover))
		self.assertEqual(frappe.db.get_value("User", self.handover, "enabled"), 0)
		self.assertTrue(frappe.db.exists("AWANZ Associate", self.handover))
		self.assertEqual(frappe.db.get_value("AWANZ Associate", self.handover, "enabled"), 0)
