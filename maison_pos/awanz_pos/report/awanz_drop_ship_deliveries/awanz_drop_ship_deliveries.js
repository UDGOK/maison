// AWANZ POS v1.0 — AWANZ Drop-ship Deliveries
frappe.query_reports["AWANZ Drop-ship Deliveries"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_months(frappe.datetime.get_today(), -6), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "store", label: __("Store"), fieldtype: "Link", options: "AWANZ Store" },
		{ fieldname: "supplier", label: __("Vendor"), fieldtype: "Link", options: "Supplier" },
		{ fieldname: "only_open", label: __("Only Not Fully Received"), fieldtype: "Check", default: 0 }
	]
};
