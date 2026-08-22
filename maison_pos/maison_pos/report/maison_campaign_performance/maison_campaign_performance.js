// Maison POS v0.5 §M — Maison Campaign Performance (sends / opens / clicks / attributed revenue / ROI)
frappe.query_reports["Maison Campaign Performance"] = {
	filters: [
		{ fieldname: "from_date", label: __("Sales From"), fieldtype: "Date", default: frappe.datetime.add_months(frappe.datetime.get_today(), -6) },
		{ fieldname: "to_date", label: __("Sales To"), fieldtype: "Date", default: frappe.datetime.get_today() },
		{ fieldname: "boutique", label: __("Boutique"), fieldtype: "Link", options: "Maison Boutique" },
		{ fieldname: "channel", label: __("Channel"), fieldtype: "Select", options: "\nEmail\nSMS\nEvent\nPrivate viewing" },
		{ fieldname: "campaign", label: __("Campaign"), fieldtype: "Link", options: "Maison Campaign" }
	]
};
