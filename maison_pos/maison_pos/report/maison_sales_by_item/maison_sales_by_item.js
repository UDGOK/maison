// Maison POS v0.4 — Maison Sales by Item
frappe.query_reports["Maison Sales by Item"] = {
	filters: [
		{ fieldname: "company", label: __("Company"), fieldtype: "Link", options: "Company", default: frappe.defaults.get_user_default("Company") },
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "Maison Boutique" },
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.month_start(), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "group_by", label: __("Group By"), fieldtype: "Select", options: "Item\nItem Group\nDepartment", default: "Item" }
	]
};
