// AWANZ POS v1.2 — AWANZ Store Statement (internal: shows AWANZ Houston's cost and margin)
frappe.query_reports["AWANZ Store Statement"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.month_start() },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.month_end() },
		{ fieldname: "boutique", label: __("Store"), fieldtype: "Link", options: "AWANZ Store" },
		{ fieldname: "detail", label: __("Line detail (item by item)"), fieldtype: "Check", default: 0 }
	]
};
