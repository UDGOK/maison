// Maison POS v0.4 — Maison Serial Ledger
frappe.query_reports["Maison Serial Ledger"] = {
	filters: [
		{ fieldname: "company", label: __("Company"), fieldtype: "Link", options: "Company", default: frappe.defaults.get_user_default("Company") },
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "Maison Boutique" },
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.month_start(), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item" },
		{ fieldname: "serial_no", label: __("Serial No"), fieldtype: "Data" },
		{ fieldname: "status", label: __("Status"), fieldtype: "Select", options: "\nIn stock\nSold\nReturned\nDamaged\nTransferred" }
	]
};
