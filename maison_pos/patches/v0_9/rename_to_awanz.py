"""v0.9 — rename the product from **Maison** to **AWANZ** on an already-installed site.

The repository ships the new names on disk (``AWANZ Store``, ``AWANZ Associate``,
``AWANZ Receipt``, ``/awanz-dashboard``, module ``AWANZ POS`` in
``maison_pos/awanz_pos/``).  A site that was seeded before this release still holds the
old ones, and ``bench migrate`` would happily create a *second* set of doctypes,
reports and print formats next to the old ones — leaving the data stranded in
``tabMaison *``.

This patch is therefore registered under ``[pre_model_sync]``: it runs **before**
``frappe.model.sync.sync_all()`` reads the JSON files, so by the time the schema is
synced every record already carries its new name and ``rename_doc`` has moved the
tables with ``RENAME TABLE`` (no copy, no data loss).

What it renames, in order:

1. ``Module Def`` ``Maison POS`` → ``AWANZ POS`` (every DocType / Report / Print Format
   / Workspace points at it through a Link field, so they follow automatically).
2. the five roles — through ``frappe.rename_doc("Role", …)``, which carries
   ``Has Role`` rows, ``DocPerm`` / ``Custom DocPerm`` rows, workflow transitions and
   report role rows with it, so nobody loses a permission or a login.
3. the 47 doctypes (``Maison Boutique`` → ``AWANZ Store``, ``Maison Boutique Reader``
   → ``AWANZ Store Reader``, everything else ``Maison X`` → ``AWANZ X``).
4. the 11 Script Reports, the 3 print formats and the 2 workflows.
5. the leftovers ``rename_doc`` does not reach: ``Custom Field`` / ``Property Setter``
   document *names* (which embed the doctype); every column that stores a doctype
   name as **data** rather than through a Link — above all ``__Auth.doctype``, where
   v0.7 put the associates' PIN hashes, so skipping it would mean no PIN unlocks the
   till; custom-field **labels** that read "Maison"; the stored brand settings; the
   white-label snapshot key; ``Role.home_page``; and the ``Website Settings`` strings
   the white-label layer wrote from the old product name.
6. seeded tenant records that carry the old wordmark: the jewellery demo company and
   its root cost center, the loyalty programme, store display names, the simulated
   payment gateway, the demo salary structure, addresses and stock-entry remarks.

**Idempotent.** Every step checks first (``exists(old) and not exists(new)``), so
re-running it — or running it on a site installed fresh from this release, where
frappe marks all patches as already applied — does nothing.  Step 6 is best-effort:
a failure there is logged and skipped rather than aborting the migration, because
none of it is required for the product to work.

What deliberately stays (see ``docs/white-label.md`` §7):

* the python package / app name ``maison_pos`` and everything derived from it
  (``/assets/maison_pos/…``), which needs a repository rename and a re-install;
* the ``maison_*`` **custom fieldnames** on ERPNext doctypes (``Sales Invoice.maison_boutique``,
  ``Item.maison_metal``, …) — renaming those columns is a data migration across every
  seeded invoice and item for something no user reads.  Their *labels* are fixed here;
* the jewellery regression tenant's fictional mail domain ``@maison.example``, which is
  what its seeded ``User`` logins are named after.
"""

from __future__ import annotations

import re

import frappe

MODULE_OLD = "Maison POS"
MODULE_NEW = "AWANZ POS"

ROLES: dict[str, str] = {
	"Maison Associate": "AWANZ Associate",
	"Maison Manager": "AWANZ Manager",
	"Maison Regional": "AWANZ Regional",
	"Maison Head Office": "AWANZ Head Office",
	"Maison Warehouse Admin": "AWANZ Warehouse Admin",
}

# `Maison Boutique` becomes `AWANZ Store`: the brand's `store_noun` is "Store" for every
# vertical but the jewellery one, and the label already said Store on the smoke-shop profile.
DOCTYPES: dict[str, str] = {
	"Maison Age Check": "AWANZ Age Check",
	"Maison Associate": "AWANZ Associate",
	"Maison Biometric Consent": "AWANZ Biometric Consent",
	"Maison Boutique": "AWANZ Store",
	"Maison Boutique Reader": "AWANZ Store Reader",
	"Maison Campaign": "AWANZ Campaign",
	"Maison Campaign Attribution": "AWANZ Campaign Attribution",
	"Maison Campaign Item": "AWANZ Campaign Item",
	"Maison Campaign Touch": "AWANZ Campaign Touch",
	"Maison Client Interaction": "AWANZ Client Interaction",
	"Maison Client Profile": "AWANZ Client Profile",
	"Maison Client Recommendation": "AWANZ Client Recommendation",
	"Maison Client Signal": "AWANZ Client Signal",
	"Maison Commission Entry": "AWANZ Commission Entry",
	"Maison Commission Rule": "AWANZ Commission Rule",
	"Maison Coupon": "AWANZ Coupon",
	"Maison Coupon Redemption": "AWANZ Coupon Redemption",
	"Maison Cycle Count": "AWANZ Cycle Count",
	"Maison Device Heartbeat": "AWANZ Device Heartbeat",
	"Maison Face Template": "AWANZ Face Template",
	"Maison Feedback": "AWANZ Feedback",
	"Maison Giveaway": "AWANZ Giveaway",
	"Maison Giveaway Entry": "AWANZ Giveaway Entry",
	"Maison Insight Report": "AWANZ Insight Report",
	"Maison Item Change Request": "AWANZ Item Change Request",
	"Maison POS Settings": "AWANZ POS Settings",
	"Maison Price Change Request": "AWANZ Price Change Request",
	"Maison Product Trend": "AWANZ Product Trend",
	"Maison Promotion Calendar": "AWANZ Promotion Calendar",
	"Maison Promotion Calendar Item": "AWANZ Promotion Calendar Item",
	"Maison Promotion Calendar Rule": "AWANZ Promotion Calendar Rule",
	"Maison Rebalance Suggestion": "AWANZ Rebalance Suggestion",
	"Maison Receiving Discrepancy": "AWANZ Receiving Discrepancy",
	"Maison Recognition Event": "AWANZ Recognition Event",
	"Maison Replenishment Line": "AWANZ Replenishment Line",
	"Maison Replenishment Request": "AWANZ Replenishment Request",
	"Maison Reward Tier": "AWANZ Reward Tier",
	"Maison Salon Playlist": "AWANZ Salon Playlist",
	"Maison Salon Playlist Item": "AWANZ Salon Playlist Item",
	"Maison Salon Session": "AWANZ Salon Session",
	"Maison Shift": "AWANZ Shift",
	"Maison Shipment": "AWANZ Shipment",
	"Maison Shipment Line": "AWANZ Shipment Line",
	"Maison Stock Alert": "AWANZ Stock Alert",
	"Maison Sync Log": "AWANZ Sync Log",
	"Maison Web Enquiry": "AWANZ Web Enquiry",
	"Maison Wishlist Item": "AWANZ Wishlist Item",
}

REPORTS: dict[str, str] = {
	"Maison Campaign Performance": "AWANZ Campaign Performance",
	"Maison Client Purchases": "AWANZ Client Purchases",
	"Maison Commission Statement": "AWANZ Commission Statement",
	"Maison Daily Sales": "AWANZ Daily Sales",
	"Maison Hourly Sales Heatmap": "AWANZ Hourly Sales Heatmap",
	"Maison Promotion Performance": "AWANZ Promotion Performance",
	"Maison Returns": "AWANZ Returns",
	"Maison Sales by Associate": "AWANZ Sales by Associate",
	"Maison Sales by Item": "AWANZ Sales by Item",
	"Maison Sales Tax Summary": "AWANZ Sales Tax Summary",
	"Maison Serial Ledger": "AWANZ Serial Ledger",
}

PRINT_FORMATS: dict[str, str] = {
	"Maison Receipt": "AWANZ Receipt",
	"Maison Return Receipt": "AWANZ Return Receipt",
	"Maison Packing List": "AWANZ Packing List",
}

WORKFLOWS: dict[str, str] = {
	"Maison Price Approval": "AWANZ Price Approval",
	"Maison Replenishment Approval": "AWANZ Replenishment Approval",
}

# Records the demo / CloudChaserz seeds create with the old wordmark in their name.
TENANT_RECORDS: dict[str, dict[str, str]] = {
	"Company": {"Maison": "AWANZ"},
	"Cost Center": {"Maison - MSN": "AWANZ - MSN"},
	"Loyalty Program": {"Maison Collectors": "AWANZ Collectors"},
	"Payment Gateway": {"Maison Simulated": "AWANZ Simulated"},
	"Salary Structure": {"Maison Base": "AWANZ Base"},
	"Salary Component": {"Maison Commission": "AWANZ Commission"},
}

# Stored *text* a user reads that carries the old wordmark: denormalised store names on the
# warehouse desk and wall, the checkout message the shopper sees, seeded storefront copy, the
# desk help item and sidebar titles the white-label layer derived from the old brand, and the
# journal remark on the seeded opening stock.
TEXT_COLUMNS: tuple[tuple[str, str], ...] = (
	("AWANZ Replenishment Request", "boutique_name"),
	("AWANZ Shipment", "boutique_name"),
	("AWANZ Salon Playlist", "title"),
	("Payment Request", "message"),
	("Payment Request", "payment_gateway"),
	("Payment Gateway Account", "message"),
	("Website Item", "short_description"),
	("Website Item", "web_long_description"),
	("Item", "description"),
	("Stock Entry", "remarks"),
	("GL Entry", "remarks"),
	("Navbar Item", "item_label"),
	# `Workspace.label` is the docname *and* the desk route (docs/white-label.md §6) — title only
	("Workspace", "title"),
)

# Documents whose *name* embeds a doctype we renamed.
PREFIXED_NAME_DOCTYPES = ("Custom Field", "Property Setter", "Client Script")

OLD_BACKUP_KEY = "maison_whitelabel_backup"
NEW_BACKUP_KEY = "awanz_whitelabel_backup"


# ---------------------------------------------------------------------------
def execute() -> None:
	# `DocType.before_rename` refuses for anyone but Administrator, and
	# `DocType.after_rename` would try to move the on-disk folder (already moved by the
	# repository) unless it believes it is inside a patch. Both hold during `bench migrate`;
	# set them anyway so `bench execute …rename_to_awanz.execute` behaves identically.
	previous_user = frappe.session.user
	previous_flag = frappe.flags.in_patch
	frappe.set_user("Administrator")
	frappe.flags.in_patch = True
	try:
		counts = {
			"module": rename_module(),
			"roles": rename_roles(),
			"doctypes": rename_doctypes(),
			"reports": rename_reports(),
			"print_formats": rename_print_formats(),
			"workflows": rename_workflows(),
			"document_names": fix_prefixed_document_names(),
			"references": fix_doctype_reference_columns(),
			"labels": relabel_custom_fields(),
			"settings": rebrand_stored_settings(),
			"tenant": rebrand_tenant_records(),
		}
		frappe.db.commit()
	finally:
		frappe.flags.in_patch = previous_flag
		frappe.set_user(previous_user)

	frappe.clear_cache()
	if any(counts.values()):
		print("maison_pos: v0.9 Maison -> AWANZ — " + ", ".join(f"{k}: {v}" for k, v in counts.items() if v))
	else:
		print("maison_pos: v0.9 Maison -> AWANZ — nothing to do (already AWANZ)")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _rename(doctype: str, old: str, new: str) -> bool:
	"""``rename_doc`` guarded so the patch can be re-run at any point."""
	if old == new or not frappe.db.exists("DocType", doctype):
		return False
	if not frappe.db.exists(doctype, old) or frappe.db.exists(doctype, new):
		return False
	# `force` skips the `allow_rename` check (DocType, Report and Cost Center all have it off);
	# `rebuild_search=False` keeps the patch from queueing a global-search rebuild per rename.
	# Permissions are not a concern — `execute()` runs this as Administrator.
	frappe.rename_doc(doctype, old, new, force=True, show_alert=False, rebuild_search=False)
	return True


def _try(label: str, fn, *args) -> int:
	"""Best-effort step: log and carry on — a cosmetic rename must not fail a migration."""
	frappe.db.commit()
	try:
		out = int(fn(*args))
		frappe.db.commit()
		return out
	except Exception as exc:
		frappe.db.rollback()
		frappe.log_error(frappe.get_traceback(), f"v0.9 rename_to_awanz: {label}")
		print(f"maison_pos: v0.9 rename — skipped {label} ({exc})")
		return 0


def _rebrand(value: str) -> str:
	""""Maison POS by CloudChaserz" -> "AWANZ POS by CloudChaserz".

	Case-sensitive on purpose: the lower-case ``maison`` in ``maison_pos`` and in the
	jewellery tenant's ``@maison.example`` addresses is deliberately left alone.
	"""
	return re.sub(r"MAISON", "AWANZ", re.sub(r"Maison", "AWANZ", value))


# ---------------------------------------------------------------------------
# 1-4: the renames frappe can do for us
# ---------------------------------------------------------------------------
def rename_module() -> int:
	if not frappe.db.exists("Module Def", MODULE_OLD):
		return 0
	if frappe.db.exists("Module Def", MODULE_NEW):
		# both present (a half-finished run): move everything across and drop the old one
		for dt, field in (("DocType", "module"), ("Report", "module"), ("Print Format", "module")):
			frappe.db.set_value(dt, {field: MODULE_OLD}, field, MODULE_NEW, update_modified=False)
		frappe.delete_doc("Module Def", MODULE_OLD, force=True, ignore_permissions=True)
		return 1
	return int(_rename("Module Def", MODULE_OLD, MODULE_NEW))


def rename_roles() -> int:
	return sum(int(_rename("Role", old, new)) for old, new in ROLES.items())


def rename_doctypes() -> int:
	done = 0
	for old, new in DOCTYPES.items():
		if _rename("DocType", old, new):
			done += 1
	return done


def rename_reports() -> int:
	return sum(int(_rename("Report", old, new)) for old, new in REPORTS.items())


def rename_print_formats() -> int:
	return sum(int(_rename("Print Format", old, new)) for old, new in PRINT_FORMATS.items())


def rename_workflows() -> int:
	done = 0
	for old, new in WORKFLOWS.items():
		if _rename("Workflow", old, new):
			# `workflow_name` is the autoname source; rename_doc updates it, but a workflow
			# imported from a fixture can carry a stale copy.
			frappe.db.set_value("Workflow", new, "workflow_name", new, update_modified=False)
			done += 1
	return done


# ---------------------------------------------------------------------------
# 5: the leftovers
# ---------------------------------------------------------------------------
def fix_prefixed_document_names() -> int:
	"""``Custom Field.name`` is ``<dt>-<fieldname>``; ``rename_doc`` moves ``dt`` but not the name.

	Left alone, ``frappe.db.exists("Custom Field", "AWANZ POS Settings-brand_name")`` is False
	on a migrated site while ``create_custom_fields`` (which looks the row up by ``dt`` +
	``fieldname``) keeps working — a mismatch that bites the next person who writes the
	obvious lookup. Same story for ``Property Setter`` (``<dt>-<field>-<property>``).
	"""
	done = 0
	for doctype in PREFIXED_NAME_DOCTYPES:
		if not frappe.db.exists("DocType", doctype):
			continue
		table = f"tab{doctype}"
		for old, new in DOCTYPES.items():
			rows = frappe.db.sql(
				f"select name from `{table}` where name like %s", (old + "-%",), as_dict=True
			)
			for row in rows:
				new_name = new + row.name[len(old) :]
				if frappe.db.exists(doctype, new_name):
					continue
				frappe.db.sql(
					f"update `{table}` set name = %s where name = %s", (new_name, row.name)
				)
				done += 1
	return done


# Columns that hold a doctype *name as data* rather than through a Link field.
# `rename_doc` rewrites Link values, `parenttype` and the DocField/Custom Field `options`
# of the doctype it is renaming — it does not know about these. The one that actually
# breaks the product is ``__Auth.doctype``: v0.7 moved every associate's PIN hash out of
# the table into ``__Auth`` (encrypted), keyed by (doctype, name, fieldname), so leaving it
# behind means **no PIN unlocks the till** after the rename. The rest are the audit trail,
# attachments, assignments and workflow actions.
REFERENCE_COLUMNS = (
	"doctype",
	"parenttype",
	"parent_doctype",
	"reference_doctype",
	"reference_type",
	"ref_doctype",
	"ref_report_doctype",
	"attached_to_doctype",
	"link_doctype",
	"share_doctype",
	"deleted_doctype",
	"document_type",
	"webhook_doctype",
	"for_doctype",
	"dt",
	"doc_type",
	"allow",
)


def _reference_tables() -> list[tuple[str, str]]:
	rows = frappe.db.sql(
		"""select table_name, column_name from information_schema.columns
		where table_schema = %s and column_name in %s""",
		(frappe.conf.db_name, REFERENCE_COLUMNS),
		as_dict=True,
	)
	return [(r.table_name, r.column_name) for r in rows]


def fix_doctype_reference_columns() -> int:
	done = 0
	for table, column in _reference_tables():
		if table == "__Auth":
			_resolve_auth_collisions(column)
		for old, new in sorted(DOCTYPES.items(), key=lambda kv: -len(kv[0])):
			try:
				hits = frappe.db.sql(
					f"select count(*) from `{table}` where `{column}` = %s", (old,)
				)[0][0]
				if not hits:
					continue
				frappe.db.sql(f"update `{table}` set `{column}` = %s where `{column}` = %s", (new, old))
				done += hits
			except Exception:
				# a view, an incompatible column type, or a unique key already holding the new
				# value — never worth failing a migration for
				frappe.db.rollback()
				continue
	return done


def _resolve_auth_collisions(column: str) -> None:
	"""``__Auth`` is keyed on (doctype, name, fieldname), so the update collides when a row
	was already written under the new doctype (a PIN reset between two runs of this patch).
	The newer row is the live secret; drop the stale one so the rename can proceed."""
	for old, new in DOCTYPES.items():
		try:
			frappe.db.sql(
				f"""delete stale from `__Auth` stale
				join `__Auth` fresh
				  on fresh.name = stale.name and fresh.fieldname = stale.fieldname
				 and fresh.`{column}` = %s
				where stale.`{column}` = %s""",
				(new, old),
			)
		except Exception:
			frappe.db.rollback()
			continue


def relabel_custom_fields() -> int:
	"""No field a user can open may still be labelled "Maison" — the fieldnames stay."""
	done = 0
	for row in frappe.get_all(
		"Custom Field", filters={"label": ("like", "%Maison%")}, fields=["name", "label"]
	):
		frappe.db.set_value("Custom Field", row.name, "label", _rebrand(row.label), update_modified=False)
		done += 1
	# ...and the standard DocFields of the renamed doctypes
	for row in frappe.db.sql(
		"select name, label from `tabDocField` where label like %s", ("%Maison%",), as_dict=True
	):
		frappe.db.sql(
			"update `tabDocField` set label = %s where name = %s", (_rebrand(row.label), row.name)
		)
		done += 1
	return done


BRAND_SETTINGS = "AWANZ POS Settings"


def rebrand_stored_settings() -> int:
	"""The tenant's saved brand tokens, and the white-label values derived from them."""
	done = 0
	if frappe.db.exists("DocType", BRAND_SETTINGS):
		rows = frappe.db.sql(
			"select field, value from tabSingles where doctype = %s and value like %s",
			(BRAND_SETTINGS, "%aison%"),
			as_dict=True,
		)
		for row in rows:
			value = _rebrand(row.value)
			# `sub_mark` sat under the wordmark as the product name; it is just the mark now.
			if row.field == "sub_mark" and value == "AWANZ POS":
				value = "AWANZ"
			if value != row.value:
				frappe.db.set_single_value(BRAND_SETTINGS, row.field, value)
				done += 1

	# Website / System Settings strings the white-label layer wrote from the old product name.
	for doctype, fields in (
		(
			"Website Settings",
			("app_name", "title_prefix", "brand_html", "copyright", "footer_powered", "banner_html", "footer_logo", "app_logo", "favicon", "splash_image"),
		),
		("System Settings", ("app_name", "otp_issuer_name", "email_footer_address")),
	):
		for field in fields:
			try:
				value = frappe.db.get_single_value(doctype, field)
			except Exception:
				continue
			if isinstance(value, str) and ("Maison" in value or "MAISON" in value):
				frappe.db.set_single_value(doctype, field, _rebrand(value))
				done += 1

	# the white-label revert snapshot moved key
	raw = frappe.db.get_global(OLD_BACKUP_KEY)
	if raw and not frappe.db.get_global(NEW_BACKUP_KEY):
		frappe.db.set_global(NEW_BACKUP_KEY, raw)
		frappe.db.set_global(OLD_BACKUP_KEY, None)
		done += 1

	# `role_home_page` sends Head Office / Regional to the dashboard; the stored Role rows
	# carry the route too, and /maison-dashboard no longer resolves.
	for role in ROLES.values():
		if frappe.db.exists("Role", role) and frappe.db.get_value("Role", role, "home_page") == "/maison-dashboard":
			frappe.db.set_value("Role", role, "home_page", "/awanz-dashboard", update_modified=False)
			done += 1
	return done


# ---------------------------------------------------------------------------
# 6: seeded tenant records (best effort)
# ---------------------------------------------------------------------------
def rebrand_tenant_records() -> int:
	done = 0
	for doctype, mapping in TENANT_RECORDS.items():
		for old, new in mapping.items():
			done += _try(f"{doctype} {old}", _rename, doctype, old, new)

	# `Payment Gateway Account` is named "<gateway> - <currency> - <abbr>"
	done += _try("Payment Gateway Account", _rename_by_prefix, "Payment Gateway Account", "Maison Simulated", "AWANZ Simulated")
	# demo customer addresses titled "… collect at Maison Oak Street"
	done += _try("Address", _rename_by_prefix, "Address", None, None, "address_title")
	# the seeded Salon playlist ("Maison · House Selection") plays on the client-facing screen
	done += _try("AWANZ Salon Playlist", _rename_by_prefix, "AWANZ Salon Playlist", None, None, "title")
	done += _try("store display names", _rebrand_store_names)
	done += _try("stored copy", _rebrand_text_columns)
	done += _try("help menu", _dedupe_support_navbar_item)
	done += _try("brand mark", _reset_brand_mark)
	return done


def _dedupe_support_navbar_item() -> int:
	"""``<brand> Support`` is appended by the white-label layer when it is not already there.

	A site that ran a migrate between the brand rename and this patch got a second item —
	"AWANZ Support" added next to the "Maison Support" this patch then renames to the same
	label. Keep the first, drop the rest.
	"""
	if not frappe.db.exists("DocType", "Navbar Item"):
		return 0
	rows = frappe.db.sql(
		"""select name, item_label from `tabNavbar Item`
		where parentfield = 'help_dropdown' and item_label like %s order by idx, creation""",
		("%Support",),
		as_dict=True,
	)
	seen: set[str] = set()
	dropped = 0
	for row in rows:
		if row.item_label in seen:
			frappe.db.delete("Navbar Item", {"name": row.name})
			dropped += 1
		else:
			seen.add(row.item_label)
	return dropped


def _rebrand_text_columns() -> int:
	done = 0
	for doctype, column in TEXT_COLUMNS:
		if not frappe.db.exists("DocType", doctype):
			continue
		table = f"tab{doctype}"
		try:
			hits = frappe.db.sql(
				f"select count(*) from `{table}` where `{column}` like %s", ("%Maison%",)
			)[0][0]
			if not hits:
				continue
			frappe.db.sql(
				f"""update `{table}`
				set `{column}` = replace(replace(`{column}`, 'Maison ', 'AWANZ '), 'Maison', 'AWANZ')
				where `{column}` like %s""",
				("%Maison%",),
			)
			done += hits
		except Exception:
			frappe.db.rollback()
			continue
	return done


def _reset_brand_mark() -> int:
	"""The generated wordmark mark used to be ``/files/maison-brand-mark.svg``.

	``whitelabel._ensure_generated_mark`` is content-addressed: asked for
	``awanz-brand-mark.svg`` it finds the identical SVG already on disk and hands back the *old*
	URL, so favicon / app logo / splash would keep the old filename forever. Drop the File rows
	and blank the settings that point at them; ``setup_whitelabel()`` — which runs later in the
	same ``after_migrate`` — writes the mark out again under its new name.
	"""
	rows = frappe.db.sql(
		"select name from `tabFile` where file_url like %s or file_name like %s",
		("%maison-brand-mark%", "%maison-brand-mark%"),
		as_dict=True,
	)
	if not rows:
		return 0
	frappe.db.sql(
		"delete from `tabFile` where file_url like %s or file_name like %s",
		("%maison-brand-mark%", "%maison-brand-mark%"),
	)
	for doctype, fields in (
		("Website Settings", ("app_logo", "favicon", "splash_image", "footer_logo")),
		("Navbar Settings", ("app_logo",)),
	):
		if not frappe.db.exists("DocType", doctype):
			continue
		for field in fields:
			value = frappe.db.get_single_value(doctype, field)
			if isinstance(value, str) and "maison-brand-mark" in value:
				frappe.db.set_single_value(doctype, field, "")
	frappe.cache.delete_value("awanz_brand_mark_url")
	return len(rows)


def _rename_by_prefix(doctype: str, old: str | None, new: str | None, title_field: str | None = None) -> int:
	"""Rename every ``doctype`` whose name starts with ``old`` (or simply contains "Maison")."""
	if not frappe.db.exists("DocType", doctype):
		return 0
	like = f"{old}%" if old else "%Maison%"
	rows = frappe.db.sql(f"select name from `tab{doctype}` where name like %s", (like,), as_dict=True)
	done = 0
	for row in rows:
		target = row.name.replace(old, new, 1) if old else _rebrand(row.name)
		if _rename(doctype, row.name, target):
			if title_field:
				current = frappe.db.get_value(doctype, target, title_field)
				if isinstance(current, str) and "Maison" in current:
					frappe.db.set_value(doctype, target, title_field, _rebrand(current), update_modified=False)
			done += 1
	return done


def _rebrand_store_names() -> int:
	""""Maison Fifth Avenue" is what the POS store picker and the Command wall print."""
	doctype = "AWANZ Store"
	if not frappe.db.exists("DocType", doctype):
		return 0
	done = 0
	for row in frappe.get_all(
		doctype, filters={"boutique_name": ("like", "%Maison%")}, fields=["name", "boutique_name"]
	):
		frappe.db.set_value(doctype, row.name, "boutique_name", _rebrand(row.boutique_name), update_modified=False)
		done += 1
	return done

