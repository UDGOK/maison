// AWANZ POS v0.4 — AWANZ Sales by Associate
frappe.query_reports["AWANZ Sales by Associate"] = {
	filters: [
		{ fieldname: "company", label: __("Company"), fieldtype: "Link", options: "Company", default: frappe.defaults.get_user_default("Company") },
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "AWANZ Store" },
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.month_start(), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 }
	]
};
