/* Maison storefront helpers (vanilla; frappe-web.bundle.js provides frappe.call + csrf). */
(function () {
  const MW = (window.MW = window.MW || {});

  MW.toast = function (msg, kind) {
    const el = document.getElementById('mw-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'mw-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'mw-toast'), 3600);
  };

  MW.money = function (v, currency) {
    const n = Number(v || 0);
    const opts = { style: 'currency', currency: currency || 'USD', minimumFractionDigits: Math.abs(n - Math.round(n)) < 0.005 ? 0 : 2, maximumFractionDigits: 2 };
    try { return new Intl.NumberFormat('en-US', opts).format(n); } catch (e) { return '$' + n.toFixed(2); }
  };

  MW.call = function (method, args) {
    return new Promise((resolve, reject) => {
      frappe.call({
        method,
        args: args || {},
        callback: (r) => resolve(r.message),
        error: (r) => reject(r),
        always: () => {}
      });
    });
  };

  MW.errorText = function (r) {
    try {
      if (r && r._server_messages) {
        const msgs = JSON.parse(r._server_messages).map((m) => JSON.parse(m).message);
        return msgs.join(' ').replace(/<[^>]+>/g, '');
      }
      if (r && r.exception) return String(r.exception).split('\n').pop().replace(/^.*?: /, '');
    } catch (e) { /* ignore */ }
    return 'Something went wrong';
  };

  MW.signedIn = function () {
    return document.body.getAttribute('frappe-session-status') === 'logged-in';
  };

  MW.requireLogin = function () {
    if (MW.signedIn()) return true;
    window.location.href = '/login?redirect-to=' + encodeURIComponent(window.location.pathname + window.location.search);
    return false;
  };

  MW.setCartCount = function (n) {
    const el = document.getElementById('mw-cart-count');
    if (el) el.textContent = n;
  };

  MW.addToCart = async function (item_code, qty, btn) {
    if (!MW.requireLogin()) return;
    if (btn) btn.disabled = true;
    try {
      const r = await MW.call('webshop.webshop.shopping_cart.cart.update_cart', { item_code, qty: qty || 1 });
      try { const c = await MW.call('maison_pos.api.webshop.cart'); MW.setCartCount((c.items || []).length); } catch (e) { /* ignore */ }
      MW.toast('Added to your bag');
      return r || {};
    } catch (e) {
      MW.toast(MW.errorText(e), 'crit');
      throw e;
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  MW.sheet = function (id, open) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('open', !!open);
    document.body.style.overflow = open ? 'hidden' : '';
  };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mw-sheet]');
    if (t) { e.preventDefault(); MW.sheet(t.getAttribute('data-mw-sheet'), true); }
    const c = e.target.closest('[data-mw-close]');
    if (c) { e.preventDefault(); MW.sheet(c.getAttribute('data-mw-close'), false); }
    if (e.target.classList && e.target.classList.contains('mw-sheet-backdrop')) MW.sheet(e.target.id, false);
    const b = e.target.closest('#mw-burger');
    if (b) { const d = document.getElementById('mw-drawer'); d && d.classList.toggle('open'); }
  });
})();
