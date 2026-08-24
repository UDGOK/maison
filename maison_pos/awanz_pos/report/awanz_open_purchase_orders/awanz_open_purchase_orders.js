// AWANZ POS v1.0 — AWANZ Open Purchase Orders
frappe.query_reports["AWANZ Open Purchase Orders"] = {
	filters: [
		{ fieldname: "supplier", label: __("Vendor"), fieldtype: "Link", options: "Supplier" },
		{ fieldname: "store", label: __("Drop-ship Store"), fieldtype: "Link", options: "AWANZ Store" },
		{ fieldname: "include_drafts", label: __("Include Drafts"), fieldtype: "Check", default: 1 }
	]
};
