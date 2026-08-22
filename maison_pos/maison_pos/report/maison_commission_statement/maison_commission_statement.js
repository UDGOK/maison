// Maison POS v0.4 — Maison Commission Statement (per associate per period; associates see their own)
frappe.query_reports["Maison Commission Statement"] = {
	filters: [
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "Maison Boutique" },
		{ fieldname: "associate", label: __("Associate"), fieldtype: "Link", options: "Maison Associate" },
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.month_start(), reqd: 1 },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1 },
		{ fieldname: "status", label: __("Status"), fieldtype: "Select", options: "\nOpen\nExported\nPaid" },
		{ fieldname: "detail", label: __("Show entries"), fieldtype: "Check", default: 0 }
	]
};
