// AWANZ POS v1.0 — AWANZ Item Purchase History
frappe.query_reports["AWANZ Item Purchase History"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_months(frappe.datetime.get_today(), -12), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item" },
		{ fieldname: "supplier", label: __("Vendor"), fieldtype: "Link", options: "Supplier" }
	]
};
