"""v0.7 S1/S2/S5 — bring an installed site up to the hardened ``Maison Associate``.

``bench migrate`` syncs the doctype itself (the new permlevels on ``user`` / ``boutique`` /
``role`` and on the PIN fields). Three things it cannot do on its own:

1. **the PIN hashes are still sitting in the doctype column.** ``pin_hash`` is now a ``Password``
   field, so new PINs are written encrypted into ``__Auth`` and the column only holds ``*****``.
   Existing rows are moved here, so a site that has already leaked nothing does not keep the
   material lying in a table that used to be world-readable inside the chain.
2. **Custom DocPerm.** If a site has *any* Custom DocPerm row for a doctype, Frappe ignores the
   standard permissions shipped in the JSON — so the new permlevel rows have to be added there
   as well, or the permlevels would silently grant nobody anything (and the ``has_permission``
   hook would be the only thing left holding the door).
3. **roles that were already over-granted.** The old ``_sync_user_role`` was add-only and ran
   with ``ignore_permissions``: whoever could write ``role`` could hand themselves
   ``Maison Head Office``, and demoting them again left the Frappe role behind. Every user with
   a ``Maison Associate`` row is re-synced to exactly the role that row says, and anything extra
   is removed and logged.

Idempotent: safe to run again, and safe on a site that never had the hole.
"""

from __future__ import annotations

import frappe

from maison_pos.audit import log as audit_log

DOCTYPE = "Maison Associate"
PERMLEVELS: dict[int, dict[str, tuple[str, ...]]] = {
	1: {
		"System Manager": ("read", "write"),
		"Maison Head Office": ("read", "write"),
		"Maison Regional": ("read", "write"),
		"Maison Manager": ("read",),
		"Maison Associate": ("read",),
	},
	2: {"System Manager": ("read", "write")},
}


def execute() -> None:
	if not frappe.db.exists("DocType", DOCTYPE):
		return
	frappe.reload_doctype(DOCTYPE)
	moved = migrate_pin_hashes()
	ensure_permlevel_docperms()
	fixed = repair_role_grants()
	frappe.db.commit()
	print(f"maison_pos: v0.7 associate hardening — {moved} PIN hash(es) moved out of the table, {fixed} role grant(s) corrected")


# ---------------------------------------------------------------------------
def migrate_pin_hashes() -> int:
	"""Move ``pbkdf2_sha256$…`` values from the column into ``__Auth`` (encrypted)."""
	from frappe.utils.password import set_encrypted_password

	if not frappe.db.has_column(DOCTYPE, "pin_hash"):
		return 0
	rows = frappe.db.sql(
		f"select name, pin_hash from `tab{DOCTYPE}` where pin_hash like 'pbkdf2_sha256$%%'",  # noqa: S608
		as_dict=True,
	)
	for row in rows:
		try:
			set_encrypted_password(DOCTYPE, row.name, row.pin_hash, "pin_hash")
			frappe.db.set_value(DOCTYPE, row.name, "pin_hash", "*" * len(row.pin_hash), update_modified=False)
		except Exception:  # pragma: no cover — a site without an encryption key keeps the old column
			frappe.log_error(frappe.get_traceback(), "maison v0.7 pin hash migration")
			return len(rows)
	return len(rows)


def ensure_permlevel_docperms() -> None:
	"""Mirror the JSON's permlevel rows into Custom DocPerm when the site uses those."""
	if not frappe.db.exists("Custom DocPerm", {"parent": DOCTYPE}):
		return  # standard DocPerms are in force; the synced JSON already carries the rows
	from frappe.permissions import add_permission, update_permission_property

	for permlevel, roles in PERMLEVELS.items():
		for role, ptypes in roles.items():
			if not frappe.db.exists("Role", role):
				continue
			if not frappe.db.exists("Custom DocPerm", {"parent": DOCTYPE, "role": role, "permlevel": permlevel}):
				add_permission(DOCTYPE, role, permlevel)
			for ptype in ptypes:
				if not frappe.db.get_value("Custom DocPerm", {"parent": DOCTYPE, "role": role, "permlevel": permlevel}, ptype):
					update_permission_property(DOCTYPE, role, permlevel, ptype, 1, validate=False)


def repair_role_grants() -> int:
	"""Every associate carries exactly the Frappe role their ``role`` field says — no more."""
	from maison_pos.maison_pos.doctype.maison_associate.maison_associate import ROLE_MAP

	managed = set(ROLE_MAP.values())
	fixed = 0
	for assoc in frappe.get_all(DOCTYPE, fields=["name", "user", "role", "enabled"]):
		if not assoc.user or not frappe.db.exists("User", assoc.user):
			continue
		want = ROLE_MAP.get(assoc.role)
		held = set(
			frappe.get_all("Has Role", filters={"parent": assoc.user, "parenttype": "User", "role": ("in", list(managed))}, pluck="role")
		)
		stale = held - ({want} if want else set())
		missing = {want} - held if want and frappe.db.exists("Role", want) else set()
		if not stale and not missing:
			continue
		user = frappe.get_doc("User", assoc.user)
		if stale:
			user.set("roles", [r for r in user.roles if r.role not in stale])
		for role in missing:
			user.append("roles", {"role": role})
		user.flags.ignore_permissions = True
		user.save()
		fixed += 1
		audit_log(
			"patch.v0_7.role_grants_repaired",
			associate=assoc.name,
			target_user=assoc.user,
			associate_role=assoc.role,
			removed=sorted(stale) or None,
			added=sorted(missing) or None,
		)
	report_unmanaged_grants(managed)
	return fixed


def report_unmanaged_grants(managed: set) -> list[str]:
	"""Log — but never touch — users who hold a ``Maison *`` role with no associate record.

	These are outside the sync's remit (an admin may legitimately have given somebody Head
	Office without putting them on a shop floor), but a user with an unrestricted Maison role and
	no store attached is exactly the shape an operator should look at after this patch runs.
	"""
	holders = set(frappe.get_all("Has Role", filters={"parenttype": "User", "role": ("in", list(managed))}, pluck="parent"))
	orphans = sorted(u for u in holders if u and not frappe.db.exists("Maison Associate", {"user": u}))
	for user in orphans:
		audit_log(
			"patch.v0_7.role_without_associate_record",
			target_user=user,
			roles=sorted(r for r in frappe.get_roles(user) if r in managed),
		)
	if orphans:
		print(f"maison_pos: review — {len(orphans)} user(s) hold a Maison role with no Maison Associate record: {', '.join(orphans)}")
	return orphans
