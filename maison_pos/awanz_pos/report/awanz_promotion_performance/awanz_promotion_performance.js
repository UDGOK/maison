// AWANZ POS v0.4 — AWANZ Promotion Performance (coupons + automatic promotions)
frappe.query_reports["AWANZ Promotion Performance"] = {
	filters: [
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "AWANZ Store" },
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_days(frappe.datetime.get_today(), -30), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 }
	]
};
