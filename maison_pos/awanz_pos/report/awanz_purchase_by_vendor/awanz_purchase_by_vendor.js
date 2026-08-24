// AWANZ POS v1.0 — AWANZ Purchase by Vendor
frappe.query_reports["AWANZ Purchase by Vendor"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_months(frappe.datetime.get_today(), -12), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "supplier", label: __("Vendor"), fieldtype: "Link", options: "Supplier" }
	]
};
