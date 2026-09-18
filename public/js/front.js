// ============================================================
// 前台：手機辨識身分 → 填申請單 → 查自己的單
// 這支程式不碰任何銀行帳戶與扣抵欄位，那些在後台處理
// ============================================================
let me = null;                 // { id, name, phone }
let options = { companies: [], sites: [] };
let currentKind = 'billing';
let party = null;              // 選定的請款／付款對象
let photos = [];
let searchTimer = null;

const STATUS_LABEL = {
  draft: '草稿', pending_approval: '待核簽', approved: '已核准', scheduled: '已排款',
  invoiced: '已開票', partial: '部分收付', settled: '已完成',
};
const STATUS_CLASS = {
  draft: 'badge-gray', pending_approval: 'badge-pending', approved: 'badge-pending',
  scheduled: 'badge-pending', invoiced: 'badge-pending', partial: 'badge-warn', settled: 'badge-done',
};

// ---------- 共用請求 ----------
async function call(method, url, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify({ ...body, phone: me ? me.phone : body.phone });
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 無內容 */ }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `伺服器錯誤（${res.status}）`);
  return data;
}
const apiGet = (url) => call('GET', url.includes('?') ? `${url}&phone=${me.phone}` : `${url}?phone=${me.phone}`);

// ============================================================
// 身分
// ============================================================
document.getElementById('phone-btn').addEventListener('click', lookupUser);
document.getElementById('phone-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupUser(); });
document.getElementById('reg-btn').addEventListener('click', registerUser);
document.getElementById('reg-back').addEventListener('click', () => {
  document.getElementById('register-step').style.display = 'none';
  document.getElementById('phone-step').style.display = '';
});
document.getElementById('switch-user').addEventListener('click', () => {
  localStorage.removeItem('billingPhone');
  location.reload();
});

async function lookupUser() {
  const phone = document.getElementById('phone-input').value.trim();
  document.getElementById('id-error').textContent = '';
  try {
    const r = await call('POST', '/api/f/users/lookup', { phone });
    if (r.found) { enter(r.user); }
    else {
      document.getElementById('phone-step').style.display = 'none';
      document.getElementById('register-step').style.display = '';
    }
  } catch (err) { document.getElementById('id-error').textContent = err.message; }
}

async function registerUser() {
  try {
    const r = await call('POST', '/api/f/users/register', {
      phone: document.getElementById('phone-input').value.trim(),
      name: document.getElementById('reg-name').value.trim(),
      employee_no: document.getElementById('reg-no').value.trim(),
    });
    enter(r.user);
  } catch (err) { document.getElementById('id-error').textContent = err.message; }
}

async function enter(user) {
  me = user;
  localStorage.setItem('billingPhone', user.phone);
  document.getElementById('id-screen').style.display = 'none';
  document.getElementById('shell').style.display = 'block';
  document.getElementById('who').textContent = `${user.name}${user.employee_no ? `（${user.employee_no}）` : ''}`;
  options = await call('GET', '/api/f/options');
  fillSelect('f-company', options.companies, '請選擇歸屬公司');
  fillSelect('f-site', options.sites, '（不指定案場）');
  if (options.companies.length === 1) document.getElementById('f-company').value = options.companies[0].id;
  resetForm();
}

function fillSelect(id, list, placeholder) {
  document.getElementById(id).innerHTML = `<option value="">${placeholder}</option>`
    + list.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
}

window.addEventListener('DOMContentLoaded', async () => {
  bindTabs(); bindForm(); bindPartySearch(); bindPartyModal();
  document.getElementById('q-search').addEventListener('click', loadMine);
  document.getElementById('q-keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMine(); });
  const saved = localStorage.getItem('billingPhone');
  if (saved) {
    try {
      const r = await call('POST', '/api/f/users/lookup', { phone: saved });
      if (r.found) return enter(r.user);
    } catch (err) { /* 失敗就留在辨識頁 */ }
  }
});

// ============================================================
// 頁籤
// ============================================================
function bindTabs() {
  document.querySelectorAll('.front-tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.front-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tab.dataset.panel === 'mine') loadMine();
  }));
}

// ============================================================
// 對象搜尋（公司名稱或統一編號）
// ============================================================
function bindPartySearch() {
  const input = document.getElementById('party-search');
  const box = document.getElementById('party-results');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { box.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      try {
        const rows = await call('GET', `/api/f/counterparties?q=${encodeURIComponent(q)}`);
        box.innerHTML = rows.map((r) => `
          <button type="button" class="search-item" data-id="${r.id}" data-name="${escapeAttr(r.name)}">
            ${escapeHtml(r.name)}${r.tax_id ? `<span class="tax">${escapeHtml(r.tax_id)}</span>` : ''}
          </button>`).join('')
          + `<button type="button" class="search-item add-new">➕ 查不到？建立「${escapeHtml(q)}」</button>`;
        box.style.display = 'block';
        box.querySelectorAll('.search-item[data-id]').forEach((b) => b.addEventListener('click', () => {
          pickParty({ id: +b.dataset.id, name: b.dataset.name });
        }));
        box.querySelector('.add-new').addEventListener('click', () => openPartyModal(q));
      } catch (err) { showToast(err.message, 'error'); }
    }, 250);
  });

  document.getElementById('party-clear').addEventListener('click', () => {
    party = null;
    document.getElementById('party-picked').style.display = 'none';
    document.querySelector('.search-box').style.display = '';
    document.getElementById('party-search').value = '';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) box.style.display = 'none';
  });
}

function pickParty(p) {
  party = p;
  document.getElementById('party-results').style.display = 'none';
  document.querySelector('.search-box').style.display = 'none';
  document.getElementById('party-picked').style.display = 'flex';
  document.getElementById('party-picked-name').textContent = p.name;
}

function bindPartyModal() {
  document.getElementById('np-cancel').addEventListener('click', () => {
    document.getElementById('party-modal').style.display = 'none';
  });
  document.getElementById('np-save').addEventListener('click', async () => {
    const name = document.getElementById('np-name').value.trim();
    if (!name) return showToast('請填寫公司名稱', 'error');
    try {
      const row = await call('POST', '/api/f/counterparties', {
        name,
        tax_id: document.getElementById('np-taxid').value.trim(),
        contact_person: document.getElementById('np-person').value.trim(),
        phone_no: document.getElementById('np-phone').value.trim(),
        role: currentKind === 'billing' ? 'customer' : 'vendor',
      });
      document.getElementById('party-modal').style.display = 'none';
      pickParty(row);
      showToast(row.existed ? '系統裡已經有這家，已為您選用' : '已建立並選用', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function openPartyModal(prefill) {
  document.getElementById('party-modal-title').textContent =
    currentKind === 'billing' ? '建立新的請款對象（客戶）' : '建立新的付款對象（廠商）';
  document.getElementById('np-name').value = /^[0-9-]+$/.test(prefill) ? '' : prefill;
  document.getElementById('np-taxid').value = /^[0-9-]+$/.test(prefill) ? prefill : '';
  document.getElementById('np-person').value = '';
  document.getElementById('np-phone').value = '';
  document.getElementById('party-modal').style.display = 'flex';
  document.getElementById('party-results').style.display = 'none';
}

// ============================================================
// 申請單表單
// ============================================================
function bindForm() {
  document.querySelectorAll('.kind-tab').forEach((tab) => tab.addEventListener('click', () => {
    currentKind = tab.dataset.kind;
    document.querySelectorAll('.kind-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.getElementById('f-party-label').textContent =
      currentKind === 'billing' ? '請款對象（客戶／業主）' : '付款對象（施工廠商／供應商）';
    document.getElementById('submit-btn').textContent =
      currentKind === 'billing' ? '確認送出【請款申請單】' : '確認送出【付款申請單】';
    document.body.classList.toggle('mode-payment', currentKind === 'payment');
  }));
  document.getElementById('f-tax-free').addEventListener('change', recalc);
  document.getElementById('add-item-row').addEventListener('click', () => addItemRow());
  document.getElementById('f-photos').addEventListener('change', handlePhotos);
  document.getElementById('submit-btn').addEventListener('click', submitForm);
}

function addItemRow(item) {
  const tbody = document.getElementById('item-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="it-name" placeholder="品名／規格"></td>
    <td><input type="number" step="any" min="0" class="it-qty" value="1"></td>
    <td><input type="text" class="it-unit" value="式"></td>
    <td><input type="number" step="any" min="0" class="it-price" value="0"></td>
    <td class="it-sub num">0</td><td class="it-total num">0</td>
    <td><button class="icon-btn it-del">✕</button></td>`;
  tbody.appendChild(tr);
  tr.querySelectorAll('.it-qty, .it-price').forEach((el) => el.addEventListener('input', recalc));
  tr.querySelector('.it-del').addEventListener('click', () => {
    if (tbody.children.length > 1) { tr.remove(); recalc(); }
  });
  recalc();
}

function recalc() {
  const taxFree = document.getElementById('f-tax-free').checked;
  document.getElementById('t-tax-label').textContent = taxFree ? '免稅' : '5%';
  let subtotal = 0, total = 0;
  document.querySelectorAll('#item-tbody tr').forEach((tr) => {
    const sub = Math.round((Number(tr.querySelector('.it-qty').value) || 0) * (Number(tr.querySelector('.it-price').value) || 0));
    const tot = taxFree ? sub : Math.round(sub * 1.05);
    tr.querySelector('.it-sub').textContent = sub.toLocaleString();
    tr.querySelector('.it-total').textContent = tot.toLocaleString();
    subtotal += sub; total += tot;
  });
  document.getElementById('t-subtotal').textContent = subtotal.toLocaleString();
  document.getElementById('t-tax').textContent = (total - subtotal).toLocaleString();
  document.getElementById('t-total').textContent = total.toLocaleString();
}

function handlePhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let { width, height } = img;
        if (width > height && width > MAX) { height = Math.round(height * MAX / width); width = MAX; }
        else if (height >= width && height > MAX) { width = Math.round(width * MAX / height); height = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        photos.push({ file_name: file.name, data: canvas.toDataURL('image/jpeg', 0.7) });
        renderPhotos();
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPhotos() {
  document.getElementById('photo-count').textContent = `已選擇 ${photos.length} 張`;
  document.getElementById('photo-preview').innerHTML = photos.map((p, i) => `
    <div class="photo-item"><img src="${p.data}"><button class="photo-del" data-idx="${i}">✕</button></div>`).join('');
  document.querySelectorAll('.photo-del').forEach((b) => b.addEventListener('click', () => {
    photos.splice(+b.dataset.idx, 1); renderPhotos();
  }));
}

async function submitForm() {
  if (!party) return showToast('請先選擇或建立對象', 'error');
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  try {
    const saved = await call('POST', '/api/f/requests', {
      kind: currentKind,
      request_type: document.getElementById('f-request-type').value,
      company_id: document.getElementById('f-company').value || null,
      counterparty_id: party.id,
      site_id: document.getElementById('f-site').value || null,
      invoice_no: document.getElementById('f-invoice-no').value,
      invoice_date: document.getElementById('f-invoice-date').value,
      due_date: document.getElementById('f-due-date').value,
      is_tax_free: document.getElementById('f-tax-free').checked,
      note: document.getElementById('f-note').value,
      items: [...document.querySelectorAll('#item-tbody tr')].map((tr) => ({
        item_name: tr.querySelector('.it-name').value,
        quantity: tr.querySelector('.it-qty').value,
        unit: tr.querySelector('.it-unit').value,
        unit_price: tr.querySelector('.it-price').value,
      })),
      photos,
    });
    showToast(`${saved.doc_no} 已送出，等待核簽`, 'success');
    resetForm();
    document.querySelector('.front-tab[data-panel="mine"]').click();
  } catch (err) {
    showToast(err.message, 'error');
  } finally { btn.disabled = false; }
}

function resetForm() {
  party = null;
  document.getElementById('party-picked').style.display = 'none';
  document.querySelector('.search-box').style.display = '';
  document.getElementById('party-search').value = '';
  ['f-invoice-no', 'f-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('f-invoice-date').value = today();
  document.getElementById('f-due-date').value = '';
  document.getElementById('f-tax-free').checked = false;
  document.getElementById('f-site').value = '';
  photos = []; renderPhotos();
  document.getElementById('item-tbody').innerHTML = '';
  addItemRow();
}

// ============================================================
// 我的申請單
// ============================================================
async function loadMine() {
  const box = document.getElementById('mine-result');
  box.innerHTML = '<p class="small-note">查詢中…</p>';
  const p = new URLSearchParams();
  const kind = document.getElementById('q-kind').value;
  const keyword = document.getElementById('q-keyword').value.trim();
  if (kind) p.set('kind', kind);
  if (keyword) p.set('keyword', keyword);
  try {
    const rows = await apiGet(`/api/f/requests?${p.toString()}`);
    if (!rows.length) { box.innerHTML = '<div class="empty">還沒有送出過申請單</div>'; return; }
    box.innerHTML = rows.map((r) => `
      <div class="ticket" data-id="${r.id}">
        <div class="ticket-summary">
          <div>
            <span class="doc-no">${r.doc_no}</span>
            <span class="badge ${r.kind === 'billing' ? 'badge-billing' : 'badge-payment'}">${r.kind === 'billing' ? '請款' : '付款'}</span>
            <span class="badge ${r.voided ? 'badge-gray' : STATUS_CLASS[r.status]}">${r.voided ? '已作廢' : STATUS_LABEL[r.status]}</span>
            <div class="sub">${escapeHtml(r.counterparty_name)}　${escapeHtml(r.site_name || '—')}　${r.created_date}</div>
          </div>
          <div class="amount-col"><div class="amount">NT$ ${money(r.total)}</div><div class="sub">含稅</div></div>
        </div>
        <div class="ticket-detail" id="fd-${r.id}"></div>
      </div>`).join('');
    box.querySelectorAll('.ticket-summary').forEach((el) => el.addEventListener('click', async () => {
      const t = el.closest('.ticket');
      t.classList.toggle('expanded');
      if (t.classList.contains('expanded')) await renderMineDetail(t.dataset.id);
    }));
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

async function renderMineDetail(id) {
  const box = document.getElementById(`fd-${id}`);
  box.innerHTML = '<p class="small-note">載入中…</p>';
  try {
    const r = await apiGet(`/api/f/requests/${id}`);
    box.innerHTML = `
      <div class="detail-grid">
        <div><span>公司</span>${escapeHtml(r.company_name)}</div>
        <div><span>${r.kind === 'billing' ? '客戶' : '廠商'}</span>${escapeHtml(r.counterparty_name)}</div>
        <div><span>案場</span>${escapeHtml(r.site_name || '—')}</div>
        <div><span>發票／憑證</span>${escapeHtml(r.invoice_no || '—')}　${r.invoice_date || ''}</div>
        <div><span>稅別</span>${r.is_tax_free ? '免稅' : '應稅 5%'}</div>
        <div><span>希望撥款／收款日</span>${r.due_date || '—'}</div>
      </div>
      <div class="table-wrap"><table class="table sm">
        <thead><tr><th>品名／規格</th><th class="num">數量</th><th>單位</th><th class="num">單價</th><th class="num">未稅</th><th class="num">含稅</th></tr></thead>
        <tbody>${r.items.map((it) => `<tr>
          <td>${escapeHtml(it.item_name)}</td><td class="num">${Number(it.quantity)}</td><td>${escapeHtml(it.unit || '')}</td>
          <td class="num">${money(it.unit_price)}</td><td class="num">${money(it.subtotal)}</td><td class="num">${money(it.total)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="amount-box">未稅 ${money(r.subtotal)}　稅額 ${money(r.tax)}　<strong>含稅 ${money(r.total)}</strong></div>
      ${r.photos.length ? `<div class="photo-grid">${r.photos.map((p) => `<div class="photo-item"><img src="${p.data}"></div>`).join('')}</div>` : ''}
      ${r.note ? `<p class="small-note">備註：${escapeHtml(r.note)}</p>` : ''}
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="fprint-${r.id}">🖨️ 列印申請單</button>
      </div>
      <p class="small-note">列印版本不含收款帳戶；實際核簽、保留款與撥款狀況請洽財務。</p>`;
    document.getElementById(`fprint-${r.id}`).addEventListener('click', () => window.open(`print.html?id=${r.id}`, '_blank'));
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// 工具
// ============================================================
function money(n) { return (Number(n) || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 }); }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function showToast(msg, type) {
  const el = document.createElement('div');
  el.className = `toast ${type || ''}`;
  el.textContent = msg;
  document.getElementById('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
