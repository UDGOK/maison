// v0.7 white-label — desk chrome (`/app`) in the tenant's brand.
//
// Loaded through `app_include_js` (see hooks.py). Everything it renders comes from
// `frappe.boot.maison_brand`, which `maison_pos.setup.whitelabel.extend_bootinfo` fills from
// `Maison POS Settings` — no tenant name is written here.
//
// The desk logo, the browser tab title and the Help menu are settings-driven and handled by
// `apply_whitelabel()`; the only thing that lives in JavaScript is the About dialog, which
// Frappe hard-codes to "Frappe Framework" in `frappe/public/js/frappe/ui/toolbar/about.js`.
//
// Licence attribution is not removed: the dialog links to
// `/api/method/maison_pos.setup.whitelabel.attribution`, which lists every installed
// open-source component, its version and its licence. See docs/white-label.md.

frappe.provide("frappe.ui.misc");
frappe.provide("maison.whitelabel");

maison.whitelabel.brand = function () {
	return (frappe.boot && frappe.boot.maison_brand) || {};
};

maison.whitelabel.about = function () {
	const b = maison.whitelabel.brand();
	const product = b.product_name || b.brand_name || frappe.boot.app_name || "";
	const brand_name = b.brand_name || product;

	if (maison.whitelabel.about_dialog) {
		maison.whitelabel.about_dialog.show();
		return;
	}

	const dialog = new frappe.ui.Dialog({ title: product });
	const esc = frappe.utils.escape_html;
	const rows = [];

	if (b.tagline) {
		rows.push(`<p class="text-muted">${esc(b.tagline)}</p>`);
	}
	if (b.brand_website) {
		rows.push(
			`<p><i class='fa fa-globe fa-fw'></i> ${__("Website")}:
			<a href='${esc(b.brand_website)}' target='_blank' rel='noreferrer'>${esc(b.brand_website)}</a></p>`
		);
	}
	if (b.support_email) {
		rows.push(
			`<p><i class='fa fa-envelope fa-fw'></i> ${__("Support")}:
			<a href='mailto:${esc(b.support_email)}'>${esc(b.support_email)}</a></p>`
		);
	}
	// v0.7 — who built the platform. Brand-driven; absent when `developer_name` is cleared.
	if (b.developer_name) {
		const dev = b.developer_website
			? `<a href='${esc(b.developer_website)}' target='_blank' rel='noreferrer noopener'>${esc(
					b.developer_name
			  )}</a>`
			: esc(b.developer_name);
		rows.push(`<p class="text-muted"><i class='fa fa-code fa-fw'></i> ${__("Powered by")} ${dev}</p>`);
	}

	$(dialog.body).html(
		`<div>
			${rows.join("\n")}
			<hr>
			<h5>${__("Version")}</h5>
			<div id='maison-about-version' class='text-muted'>${__("Loading versions...")}</div>
			<hr>
			<p class='text-muted small'>
				${__("Built on open-source components.")}
				<a href='/api/method/maison_pos.setup.whitelabel.attribution' target='_blank' rel='noreferrer'>${__(
					"Licences and notices"
				)}</a>
			</p>
			<p class='text-muted small'>&copy; ${new Date().getFullYear()} ${esc(b.legal_name || brand_name)}</p>
		</div>`
	);

	dialog.on_page_show = function () {
		const $v = $(dialog.body).find("#maison-about-version");
		const versions = (frappe.boot && frappe.boot.versions) || {};
		const own = versions["maison_pos"];
		$v.text(own ? `${product} ${own}` : product);
	};

	maison.whitelabel.about_dialog = dialog;
	dialog.show();
};

// Replace the framework's About dialog wherever it is reached from (navbar Help > About and the
// keyboard shortcut both call `frappe.ui.misc.about`).
frappe.ui.misc.about = maison.whitelabel.about;

$(document).ready(function () {
	const b = maison.whitelabel.brand();
	const title = b.brand_name || (frappe.boot && frappe.boot.app_name);
	if (title && document.title && /^(Frappe|ERPNext)\b/i.test(document.title)) {
		document.title = title;
	}
	// `frappe.ui.misc.about` is re-provided by the desk bundle after our file runs in some
	// builds; re-assert once the toolbar exists.
	frappe.ui.misc.about = maison.whitelabel.about;
});
