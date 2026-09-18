// ============================================================
// 全域狀態
// ============================================================
let masters = { companies: [], counterparties: [], applicants: [], sites: [] };
let currentKind = 'billing';      // billing 請款(應收) / payment 付款(應付)
let editingId = null;             // 有值代表正在修改既有單據
let photos = [];                  // { file_name, data }
let masterType = 'counterparties';
let masterEditing = null;

const STATUS_LABEL = {
  draft: '草稿', pending_approval: '待核簽', approved: '已核准', scheduled: '已排款',
  invoiced: '已開票', partial: '部分收付', settled: '已完成',
};
const STATUS_CLASS = {
  draft: 'badge-gray', pending_approval: 'badge-pending', approved: 'badge-pending',
  scheduled: 'badge-pending', invoiced: 'badge-pending', partial: 'badge-warn', settled: 'badge-done',
};
// 每個狀態底下可以按的下一步
const NEXT_STEPS = {
  billing: {
    draft: [{ status: 'pending_approval', label: '→ 送出核簽' }],
    pending_approval: [{ status: 'approved', label: '✓ 登記核簽完成' }],
    approved: [{ status: 'invoiced', label: '→ 已開票' }],
    invoiced: [], partial: [], settled: [],
  },
  payment: {
    draft: [{ status: 'pending_approval', label: '→ 送出核簽' }],
    pending_approval: [{ status: 'approved', label: '✓ 登記核簽完成' }],
    approved: [{ status: 'scheduled', label: '→ 排入付款' }],
    scheduled: [], partial: [], settled: [],
  },
};

// ============================================================
// 登入
// ============================================================
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem('appPassword');
  location.reload();
});

async function doLogin() {
  const pw = document.getElementById('login-pw').value;
  sessionStorage.setItem('appPassword', pw);
  try {
    await Api.post('/api/login', {});
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('shell').style.display = 'grid';
    await start();
  } catch (err) {
    sessionStorage.removeItem('appPassword');
    document.getElementById('login-error').textContent = err.message;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  bindNav();
  bindForm();
  bindList();
  bindMasters();
  bindSettleModal();
  bindBankModal();
  document.getElementById('m-month').value = currentMonth();
  document.getElementById('m-month').addEventListener('change', loadMonthly);
  if (sessionStorage.getItem('appPassword')) {
    try {
      await Api.post('/api/login', {});
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('shell').style.display = 'grid';
      await start();
    } catch (err) { /* 密碼失效，留在登入頁 */ }
  }
});

async function start() {
  await loadMasters();
  resetForm();
  loadOutstanding('payment');
  loadOutstanding('billing');
  loadMonthly();
  searchRequests();
  refreshPendingBadge();
}

// ============================================================
// 側邊欄
// ============================================================
function bindNav() {
  document.querySelectorAll('.nav-item[data-panel]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.panel}`));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (btn.dataset.panel === 'list') searchRequests();
    if (btn.dataset.panel === 'payable') loadOutstanding('payment');
    if (btn.dataset.panel === 'receivable') loadOutstanding('billing');
    if (btn.dataset.panel === 'monthly') loadMonthly();
    if (btn.dataset.panel === 'masters') renderMasterTable();
    if (btn.dataset.panel === 'logs') loadLogs();
  }));
}

function goPanel(name) {
  const btn = document.querySelector(`.nav-item[data-panel="${name}"]`);
  if (btn) btn.click();
}

// ============================================================
// 主檔
// ============================================================
async function loadMasters() {
  masters = await Api.get('/api/masters');
  fillSelect('f-company', masters.companies, '請選擇歸屬公司');
  fillSelect('f-party', masters.counterparties, '請選擇對象');
  fillSelect('f-applicant', masters.applicants, '請選擇申請人');
  fillSelect('f-site', masters.sites, '（不指定案場）', true);
}

function fillSelect(id, list, placeholder, optional) {
  const sel = document.getElementById(id);
  const keep = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>`
    + list.filter((x) => x.active !== false).map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  if (keep) sel.value = keep;
  sel.dataset.optional = optional ? '1' : '';
}

// ============================================================
// 申請單表單
// ============================================================
function bindForm() {
  document.querySelectorAll('.kind-tab').forEach((tab) => tab.addEventListener('click', () => {
    if (editingId) return showToast('修改既有單據時不能切換類別', 'error');
    currentKind = tab.dataset.kind;
    document.querySelectorAll('.kind-tab').forEach((t) => t.classList.toggle('active', t === tab));
    applyKindUi();
    updateBank();
  }));

  document.getElementById('f-company').addEventListener('change', updateBank);
  document.getElementById('f-party').addEventListener('change', updateBank);
  document.getElementById('f-tax-free').addEventListener('change', recalc);
  ['f-retention', 'f-deduction', 'f-prepaid'].forEach((id) => document.getElementById(id).addEventListener('input', recalc));
  document.getElementById('add-item-row').addEventListener('click', () => addItemRow());
  document.getElementById('f-photos').addEventListener('change', handlePhotos);
  document.getElementById('submit-btn').addEventListener('click', () => submitForm('pending_approval'));
  document.getElementById('save-draft-btn').addEventListener('click', () => submitForm('draft'));
  document.getElementById('form-reset').addEventListener('click', () => { editingId = null; resetForm(); });
}

function applyKindUi() {
  const billing = currentKind === 'billing';
  document.getElementById('f-party-label').textContent = billing ? '請款對象（客戶／業主）' : '付款對象（施工廠商／供應商）';
  document.getElementById('bank-badge').textContent = billing ? '目前帶入：本公司收款帳戶' : '目前帶入：廠商收款帳戶';
  document.getElementById('bank-badge').className = `bank-badge ${billing ? '' : 'green'}`;
  document.getElementById('submit-btn').textContent = editingId
    ? '儲存修改'
    : (billing ? '確認送出【請款申請單】' : '確認送出【付款申請單】');
  document.body.classList.toggle('mode-payment', !billing);
}

// 請款抓本公司帳戶，付款抓廠商帳戶
function updateBank() {
  const src = currentKind === 'billing'
    ? masters.companies.find((c) => String(c.id) === document.getElementById('f-company').value)
    : masters.counterparties.find((c) => String(c.id) === document.getElementById('f-party').value);
  document.getElementById('f-bank-name').value = src ? (src.bank || '') : '';
  document.getElementById('f-bank-account').value = src ? (src.account || '') : '';
}

function addItemRow(item) {
  const tbody = document.getElementById('item-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="it-name" value="${item ? escapeAttr(item.item_name) : ''}" placeholder="品名／規格"></td>
    <td><input type="number" step="any" min="0" class="it-qty" value="${item ? Number(item.quantity) : 1}"></td>
    <td><input type="text" class="it-unit" value="${item ? escapeAttr(item.unit || '式') : '式'}"></td>
    <td><input type="number" step="any" min="0" class="it-price" value="${item ? Number(item.unit_price) : 0}"></td>
    <td class="it-sub num">0</td>
    <td class="it-total num">0</td>
    <td><button class="icon-btn it-del" title="刪除這列">✕</button></td>`;
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
    const qty = Number(tr.querySelector('.it-qty').value) || 0;
    const price = Number(tr.querySelector('.it-price').value) || 0;
    const sub = Math.round(qty * price);
    const tot = taxFree ? sub : Math.round(sub * 1.05);
    tr.querySelector('.it-sub').textContent = sub.toLocaleString();
    tr.querySelector('.it-total').textContent = tot.toLocaleString();
    subtotal += sub; total += tot;
  });
  const retention = Number(document.getElementById('f-retention').value) || 0;
  const deduction = Number(document.getElementById('f-deduction').value) || 0;
  const prepaid = Number(document.getElementById('f-prepaid').value) || 0;
  const net = total - retention - deduction - prepaid;
  document.getElementById('t-subtotal').textContent = subtotal.toLocaleString();
  document.getElementById('t-tax').textContent = (total - subtotal).toLocaleString();
  document.getElementById('t-total').textContent = total.toLocaleString();
  document.getElementById('t-net').textContent = net.toLocaleString();
}

// 照片在前端先縮到 1280px、壓成 JPEG，避免資料庫塞爆
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
    <div class="photo-item"><img src="${p.data}" alt="附件${i + 1}">
      <button class="photo-del" data-idx="${i}">✕</button></div>`).join('');
  document.querySelectorAll('.photo-del').forEach((btn) => btn.addEventListener('click', () => {
    photos.splice(+btn.dataset.idx, 1); renderPhotos();
  }));
}

function collectForm(status) {
  return {
    kind: currentKind,
    status,
    request_type: document.getElementById('f-request-type').value,
    company_id: document.getElementById('f-company').value || null,
    counterparty_id: document.getElementById('f-party').value || null,
    site_id: document.getElementById('f-site').value || null,
    applicant_id: document.getElementById('f-applicant').value || null,
    invoice_no: document.getElementById('f-invoice-no').value,
    invoice_date: document.getElementById('f-invoice-date').value,
    due_date: document.getElementById('f-due-date').value,
    is_tax_free: document.getElementById('f-tax-free').checked,
    retention_amount: document.getElementById('f-retention').value,
    deduction_amount: document.getElementById('f-deduction').value,
    deduction_note: document.getElementById('f-deduction-note').value,
    prepaid_offset: document.getElementById('f-prepaid').value,
    note: document.getElementById('f-note').value,
    items: [...document.querySelectorAll('#item-tbody tr')].map((tr) => ({
      item_name: tr.querySelector('.it-name').value,
      quantity: tr.querySelector('.it-qty').value,
      unit: tr.querySelector('.it-unit').value,
      unit_price: tr.querySelector('.it-price').value,
    })).filter((it) => it.item_name.trim()),
    photos,
  };
}

async function submitForm(status) {
  const payload = collectForm(status);
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  try {
    const saved = editingId
      ? await Api.put(`/api/requests/${editingId}`, payload)
      : await Api.post('/api/requests', payload);
    showToast(`${saved.doc_no} 已儲存`, 'success');
    const id = saved.id;
    editingId = null;
    resetForm();
    await loadOutstanding(payload.kind);
    if (confirm('已儲存。要立刻開啟列印畫面嗎？')) {
      window.open(`print.html?id=${id}`, '_blank');
    }
    goPanel('list');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function resetForm() {
  document.getElementById('form-title').textContent = editingId ? '修改申請單' : '新增申請單';
  document.getElementById('form-reset').style.display = editingId ? '' : 'none';
  document.getElementById('f-request-type').value = '一般工程款';
  ['f-invoice-no', 'f-note', 'f-deduction-note'].forEach((id) => { document.getElementById(id).value = ''; });
  ['f-retention', 'f-deduction', 'f-prepaid'].forEach((id) => { document.getElementById(id).value = 0; });
  document.getElementById('f-invoice-date').value = today();
  document.getElementById('f-due-date').value = '';
  document.getElementById('f-tax-free').checked = false;
  document.getElementById('f-party').value = '';
  document.getElementById('f-site').value = '';
  document.getElementById('f-applicant').value = '';
  if (masters.companies.length === 1) document.getElementById('f-company').value = masters.companies[0].id;
  photos = [];
  renderPhotos();
  document.getElementById('item-tbody').innerHTML = '';
  addItemRow();
  applyKindUi();
  updateBank();
}

async function editRequest(id) {
  try {
    const r = await Api.get(`/api/requests/${id}`);
    editingId = r.id;
    currentKind = r.kind;
    document.querySelectorAll('.kind-tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === r.kind));
    document.getElementById('f-request-type').value = r.request_type;
    document.getElementById('f-company').value = r.company_id || '';
    document.getElementById('f-party').value = r.counterparty_id || '';
    document.getElementById('f-site').value = r.site_id || '';
    document.getElementById('f-applicant').value = r.applicant_id || '';
    document.getElementById('f-invoice-no').value = r.invoice_no || '';
    document.getElementById('f-invoice-date').value = r.invoice_date || '';
    document.getElementById('f-due-date').value = r.due_date || '';
    document.getElementById('f-tax-free').checked = r.is_tax_free;
    document.getElementById('f-retention').value = Number(r.retention_amount);
    document.getElementById('f-deduction').value = Number(r.deduction_amount);
    document.getElementById('f-prepaid').value = Number(r.prepaid_offset);
    document.getElementById('f-deduction-note').value = r.deduction_note || '';
    document.getElementById('f-note').value = r.note || '';
    document.getElementById('item-tbody').innerHTML = '';
    (r.items.length ? r.items : [null]).forEach((it) => addItemRow(it));
    photos = r.photos.map((p) => ({ file_name: p.file_name, data: p.data }));
    renderPhotos();
    document.getElementById('form-title').textContent = `修改申請單　${r.doc_no}`;
    document.getElementById('form-reset').style.display = '';
    applyKindUi();
    updateBank();
    recalc();
    goPanel('new');
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// 單據查詢
// ============================================================
function bindList() {
  document.getElementById('q-search').addEventListener('click', searchRequests);
  document.getElementById('q-keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchRequests(); });
  document.getElementById('q-export').addEventListener('click', exportCsv);
}

async function refreshPendingBadge() {
  try {
    const rows = await Api.get('/api/requests?status=pending_approval');
    const badge = document.getElementById('pending-badge');
    badge.textContent = rows.length;
    badge.style.display = rows.length ? 'inline-flex' : 'none';
  } catch (err) { /* 徽章失敗不影響操作 */ }
}

async function searchRequests() {
  const box = document.getElementById('list-result');
  box.innerHTML = '<p class="small-note">查詢中…</p>';
  const p = new URLSearchParams();
  const add = (k, id) => { const v = document.getElementById(id).value; if (v) p.set(k, v); };
  add('kind', 'q-kind'); add('status', 'q-status'); add('keyword', 'q-keyword');
  add('from', 'q-from'); add('to', 'q-to');
  if (document.getElementById('q-voided').checked) p.set('include_voided', '1');

  try {
    const rows = await Api.get(`/api/requests?${p.toString()}`);
    const net = rows.reduce((s, r) => s + Number(r.net_amount), 0);
    const outstanding = rows.reduce((s, r) => s + r.outstanding, 0);
    document.getElementById('list-summary').innerHTML = rows.length
      ? `共 ${rows.length} 張　淨額合計 NT$ ${money(net)}　未結 NT$ ${money(outstanding)}`
      : '';
    refreshPendingBadge();
    if (!rows.length) { box.innerHTML = '<div class="empty">沒有符合條件的單據</div>'; return; }
    box.innerHTML = rows.map(renderRequestCard).join('');
    bindCardActions(box);
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

function renderRequestCard(r) {
  const kindText = r.kind === 'billing' ? '請款' : '付款';
  return `
  <div class="ticket ${r.voided ? 'voided' : ''}" data-id="${r.id}">
    <div class="ticket-summary">
      <div>
        <span class="doc-no">${r.doc_no}</span>
        <span class="badge ${r.kind === 'billing' ? 'badge-billing' : 'badge-payment'}">${kindText}</span>
        <span class="badge ${r.voided ? 'badge-gray' : STATUS_CLASS[r.status]}">${r.voided ? '已作廢' : STATUS_LABEL[r.status]}</span>
        <div class="sub">
          ${escapeHtml(r.counterparty_name)}　${escapeHtml(r.site_name || '—')}　${escapeHtml(r.applicant_name || '')}　${r.created_date}
        </div>
      </div>
      <div class="amount-col">
        <div class="amount">NT$ ${money(r.net_amount)}</div>
        ${r.outstanding > 0 ? `<div class="sub danger">未結 ${money(r.outstanding)}</div>` : '<div class="sub done">已結清</div>'}
      </div>
    </div>
    <div class="ticket-detail" id="detail-${r.id}"></div>
  </div>`;
}

function bindCardActions(box) {
  box.querySelectorAll('.ticket-summary').forEach((el) => el.addEventListener('click', async () => {
    const ticket = el.closest('.ticket');
    const id = ticket.dataset.id;
    ticket.classList.toggle('expanded');
    if (ticket.classList.contains('expanded')) await renderDetail(id);
  }));
}

async function renderDetail(id) {
  const box = document.getElementById(`detail-${id}`);
  box.innerHTML = '<p class="small-note">載入中…</p>';
  try {
    const r = await Api.get(`/api/requests/${id}`);
    const steps = (NEXT_STEPS[r.kind][r.status] || []);
    box.innerHTML = `
      <div class="detail-grid">
        <div><span>公司</span>${escapeHtml(r.company_name)}</div>
        <div><span>${r.kind === 'billing' ? '客戶' : '廠商'}</span>${escapeHtml(r.counterparty_name)}</div>
        <div><span>案場</span>${escapeHtml(r.site_name || '—')}</div>
        <div><span>申請人</span>${escapeHtml(r.applicant_name || '—')}</div>
        <div><span>發票／憑證</span>${escapeHtml(r.invoice_no || '—')}　${r.invoice_date || ''}</div>
        <div><span>稅別</span>${r.is_tax_free ? '免稅' : '應稅 5%'}</div>
        <div><span>收款帳戶</span>${escapeHtml(r.bank_name || '—')}　${escapeHtml(r.bank_account || '')}</div>
        <div><span>預計日</span>${r.due_date || '—'}</div>
      </div>
      ${r.voided ? `<p class="small-note danger">🚫 已作廢：${escapeHtml(r.void_reason || '')}</p>` : ''}

      <div class="table-wrap">
        <table class="table sm">
          <thead><tr><th>品名／規格</th><th class="num">數量</th><th>單位</th><th class="num">單價</th><th class="num">未稅</th><th class="num">含稅</th></tr></thead>
          <tbody>${r.items.map((it) => `<tr>
            <td>${escapeHtml(it.item_name)}</td><td class="num">${Number(it.quantity)}</td><td>${escapeHtml(it.unit || '')}</td>
            <td class="num">${money(it.unit_price)}</td><td class="num">${money(it.subtotal)}</td><td class="num">${money(it.total)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="amount-box">
        <div>未稅 ${money(r.subtotal)}　稅額 ${money(r.tax)}　含稅 ${money(r.total)}</div>
        ${Number(r.retention_amount) ? `<div>保留款 −${money(r.retention_amount)}</div>` : ''}
        ${Number(r.deduction_amount) ? `<div>扣款 −${money(r.deduction_amount)}${r.deduction_note ? `（${escapeHtml(r.deduction_note)}）` : ''}</div>` : ''}
        ${Number(r.prepaid_offset) ? `<div>預付沖抵 −${money(r.prepaid_offset)}</div>` : ''}
        <div class="net">淨額 NT$ ${money(r.net_amount)}　已${r.kind === 'billing' ? '收' : '付'} ${money(r.paid_amount)}　<strong>未結 ${money(r.outstanding)}</strong></div>
      </div>

      <div class="settle-list">
        <h4>收付紀錄</h4>
        ${r.settlements.length ? r.settlements.map((s) => `
          <div class="settle-row">
            <span>${s.paid_date}</span><span>${escapeHtml(s.method)}</span><span>${escapeHtml(s.bank || '')}</span>
            <span class="num">NT$ ${money(s.amount)}</span><span class="sub">${escapeHtml(s.note || '')}</span>
            <button class="icon-btn settle-del" data-sid="${s.id}" title="刪除這筆">✕</button>
          </div>`).join('') : '<p class="small-note">還沒有收付紀錄</p>'}
      </div>

      ${r.photos.length ? `<div class="photo-grid">${r.photos.map((p) => `<div class="photo-item"><img src="${p.data}"></div>`).join('')}</div>` : ''}
      ${r.note ? `<p class="small-note">備註：${escapeHtml(r.note)}</p>` : ''}

      <div class="btn-row">
        ${r.voided ? '' : steps.map((s) => `<button class="btn btn-primary btn-sm status-btn" data-id="${r.id}" data-status="${s.status}">${s.label}</button>`).join('')}
        ${r.voided || r.outstanding <= 0 ? '' : `<button class="btn btn-primary btn-sm settle-btn" data-id="${r.id}">💰 登記${r.kind === 'billing' ? '收款' : '付款'}</button>`}
        <button class="btn btn-secondary btn-sm print-btn" data-id="${r.id}">🖨️ 列印申請單</button>
        ${r.voided ? `<button class="btn btn-secondary btn-sm restore-btn" data-id="${r.id}">↩ 還原</button>`
          : `<button class="btn btn-secondary btn-sm edit-btn" data-id="${r.id}">✎ 修改</button>
             <button class="btn btn-danger btn-sm void-btn" data-id="${r.id}">🚫 作廢</button>`}
      </div>`;

    box.querySelectorAll('.status-btn').forEach((b) => b.addEventListener('click', async () => {
      try {
        await Api.put(`/api/requests/${b.dataset.id}/status`, { status: b.dataset.status });
        showToast('狀態已更新', 'success');
        searchRequests();
        loadOutstanding(r.kind);
      } catch (err) {
        // 主檔沒有收款帳戶時，跳出視窗請使用者補上
        if (err.code === 'need_bank') openBankModal(r, b.dataset.status, err.payload);
        else showToast(err.message, 'error');
      }
    }));
    box.querySelector('.print-btn').addEventListener('click', () => window.open(`print.html?id=${r.id}`, '_blank'));
    const editBtn = box.querySelector('.edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => editRequest(r.id));
    const settleBtn = box.querySelector('.settle-btn');
    if (settleBtn) settleBtn.addEventListener('click', () => openSettleModal(r));
    const voidBtn = box.querySelector('.void-btn');
    if (voidBtn) voidBtn.addEventListener('click', async () => {
      const reason = prompt('請填寫作廢原因：', '');
      if (reason === null) return;
      if (!reason.trim()) return showToast('請填寫作廢原因', 'error');
      try {
        await Api.put(`/api/requests/${r.id}/void`, { reason: reason.trim() });
        showToast('已作廢', 'success');
        searchRequests(); loadOutstanding(r.kind);
      } catch (err) { showToast(err.message, 'error'); }
    });
    const restoreBtn = box.querySelector('.restore-btn');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      try {
        await Api.put(`/api/requests/${r.id}/restore`, {});
        showToast('已還原', 'success'); searchRequests();
      } catch (err) { showToast(err.message, 'error'); }
    });
    box.querySelectorAll('.settle-del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('要刪除這筆收付紀錄嗎？')) return;
      try {
        await Api.del(`/api/settlements/${b.dataset.sid}`);
        showToast('已刪除', 'success');
        renderDetail(r.id); loadOutstanding(r.kind);
      } catch (err) { showToast(err.message, 'error'); }
    }));
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

async function exportCsv() {
  try {
    const res = await fetch('/api/reports/export.csv', { headers: Api.headers() });
    if (!res.ok) throw new Error('匯出失敗');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'requests.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// 登記收付
// ============================================================
function bindSettleModal() {
  document.getElementById('settle-cancel').addEventListener('click', () => {
    document.getElementById('settle-modal').style.display = 'none';
  });
  document.getElementById('settle-save').addEventListener('click', async () => {
    const id = document.getElementById('settle-request-id').value;
    try {
      await Api.post(`/api/requests/${id}/settlements`, {
        paid_date: document.getElementById('settle-date').value,
        amount: document.getElementById('settle-amount').value,
        bank: document.getElementById('settle-bank').value,
        method: document.getElementById('settle-method').value,
        note: document.getElementById('settle-note').value,
      });
      document.getElementById('settle-modal').style.display = 'none';
      showToast('已登記', 'success');
      renderDetail(id);
      searchRequests();
      loadOutstanding('payment'); loadOutstanding('billing');
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function openSettleModal(r) {
  document.getElementById('settle-request-id').value = r.id;
  document.getElementById('settle-summary').textContent =
    `${r.doc_no}　${r.counterparty_name}　未結 NT$ ${money(r.outstanding)}`;
  document.getElementById('settle-date').value = today();
  document.getElementById('settle-amount').value = r.outstanding;
  document.getElementById('settle-bank').value = '';
  document.getElementById('settle-note').value = '';
  document.getElementById('settle-modal').style.display = 'flex';
}

// ============================================================
// 核簽時補收款帳戶（主檔沒資料就跳這個視窗）
// ============================================================
let bankModalCtx = null;

function bindBankModal() {
  document.getElementById('bank-modal-cancel').addEventListener('click', () => {
    document.getElementById('bank-modal').style.display = 'none';
  });
  document.getElementById('bank-modal-save').addEventListener('click', async () => {
    const bank = document.getElementById('bank-modal-bank').value.trim();
    const account = document.getElementById('bank-modal-account').value.trim();
    if (!bank || !account) return showToast('請填寫銀行與帳號', 'error');
    if (!bankModalCtx) return;
    const { request, status, type, id } = bankModalCtx;
    try {
      // 一律寫回主檔（勾選時），再重新核簽，讓單據帶到快照
      const payload = { bank, account, tax_id: document.getElementById('bank-modal-taxid').value.trim() };
      const target = masters[type].find((x) => x.id === id) || {};
      await Api.put(`/api/masters/${type}/${id}`, { name: target.name, ...payload });
      await Api.put(`/api/requests/${request.id}/status`, { status });
      if (!document.getElementById('bank-modal-save-master').checked) {
        // 不想留在主檔：單據已經取到快照，主檔再清掉
        await Api.put(`/api/masters/${type}/${id}`, { name: target.name, bank: '', account: '' });
      }
      document.getElementById('bank-modal').style.display = 'none';
      showToast('已補上帳戶並完成核簽', 'success');
      await loadMasters();
      searchRequests();
      loadOutstanding(request.kind);
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function openBankModal(request, status, info) {
  const type = (info && info.target) || (request.kind === 'billing' ? 'companies' : 'counterparties');
  const id = (info && info.target_id) || (request.kind === 'billing' ? request.company_id : request.counterparty_id);
  const target = masters[type].find((x) => x.id === id) || { name: (info && info.target_name) || request.counterparty_name };
  bankModalCtx = { request, status, type, id };
  document.getElementById('bank-modal-summary').textContent =
    `${target.name} 尚未建立收款帳戶，補上之後才能完成核簽。`;
  document.getElementById('bank-modal-taxid').value = target.tax_id || '';
  document.getElementById('bank-modal-bank').value = target.bank || '';
  document.getElementById('bank-modal-account').value = target.account || '';
  document.getElementById('bank-modal-save-master').checked = true;
  document.getElementById('bank-modal').style.display = 'flex';
}

// ============================================================
// 未付／未收清單
// ============================================================
async function loadOutstanding(kind) {
  const isPay = kind === 'payment';
  const box = document.getElementById(isPay ? 'payable-body' : 'receivable-body');
  const badge = document.getElementById(isPay ? 'payable-badge' : 'receivable-badge');
  try {
    const data = await Api.get(`/api/reports/outstanding?kind=${kind}`);
    const count = data.parties.reduce((s, p) => s + p.items.length, 0);
    badge.textContent = count;
    badge.style.display = count ? 'inline-flex' : 'none';
    if (!data.parties.length) { box.innerHTML = '<div class="empty">目前沒有未結款項</div>'; return; }

    box.innerHTML = `
      <div class="big-total">未${isPay ? '付' : '收'}總額 NT$ ${money(data.grand_total)}　共 ${count} 張單　${data.parties.length} 家</div>
      ${data.parties.map((p) => `
        <div class="party-card">
          <div class="party-head">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="party-total">NT$ ${money(p.total)}</span>
          </div>
          <div class="aging">
            <span>30天內 ${money(p.buckets.d30)}</span>
            <span>31–60 ${money(p.buckets.d60)}</span>
            <span>61–90 ${money(p.buckets.d90)}</span>
            <span class="danger">90天以上 ${money(p.buckets.over)}</span>
          </div>
          <table class="table sm">
            <thead><tr><th>單號</th><th>案場</th><th>發票號</th><th>建立日</th><th>預計日</th><th class="num">淨額</th><th class="num">已${isPay ? '付' : '收'}</th><th class="num">未結</th><th>帳齡</th></tr></thead>
            <tbody>${p.items.map((it) => `<tr class="${it.overdue ? 'row-overdue' : ''}">
              <td><a href="#" class="jump" data-id="${it.id}">${it.doc_no}</a></td>
              <td>${escapeHtml(it.site_name || '—')}</td>
              <td>${escapeHtml(it.invoice_no || '—')}</td>
              <td>${it.created_date}</td>
              <td>${it.due_date || '—'}${it.overdue ? ' ⚠️' : ''}</td>
              <td class="num">${money(it.net_amount)}</td>
              <td class="num">${money(it.paid_amount)}</td>
              <td class="num strong">${money(it.outstanding)}</td>
              <td>${it.age_days} 天</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`).join('')}`;

    box.querySelectorAll('.jump').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('q-keyword').value = a.textContent;
      document.getElementById('q-kind').value = '';
      document.getElementById('q-status').value = '';
      goPanel('list');
    }));
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// 月結
// ============================================================
async function loadMonthly() {
  const box = document.getElementById('monthly-body');
  const month = document.getElementById('m-month').value;
  if (!month) return;
  try {
    const d = await Api.get(`/api/reports/monthly?month=${month}`);
    const card = (title, obj, verb) => `
      <div class="stat-card">
        <div class="stat-title">${title}</div>
        <div class="stat-main">NT$ ${money(obj.created.amount)}</div>
        <div class="sub">本月建立 ${obj.created.count} 張</div>
        <div class="stat-sub">本月${verb} NT$ ${money(obj.settled.amount)}（${obj.settled.count} 筆）</div>
      </div>`;
    box.innerHTML = `
      <div class="stat-row">
        ${card('應收（請款）', d.billing, '實收')}
        ${card('應付（付款）', d.payment, '實付')}
      </div>
      <div class="card">
        <h3>各案場金額（依建立月份）</h3>
        <div class="table-wrap"><table class="table sm">
          <thead><tr><th>案場</th><th>類別</th><th class="num">張數</th><th class="num">淨額</th></tr></thead>
          <tbody>${d.sites.length ? d.sites.map((s) => `<tr>
            <td>${escapeHtml(s.site_name)}</td><td>${s.kind === 'billing' ? '請款' : '付款'}</td>
            <td class="num">${s.count}</td><td class="num">${money(s.amount)}</td>
          </tr>`).join('') : '<tr><td colspan="4">這個月沒有資料</td></tr>'}</tbody>
        </table></div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<p class="small-note danger">${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// 主檔維護
// ============================================================
const MASTER_FIELDS = {
  counterparties: [
    { key: 'name', label: '名稱', required: true },
    { key: 'role', label: '身分', type: 'select', options: [['vendor', '廠商'], ['customer', '客戶'], ['both', '兩者皆是']] },
    { key: 'tax_id', label: '統一編號' }, { key: 'bank', label: '銀行' }, { key: 'account', label: '匯款帳號' },
    { key: 'contact_person', label: '負責人' }, { key: 'phone', label: '聯絡電話' }, { key: 'address', label: '地址' },
  ],
  companies: [
    { key: 'name', label: '公司名稱', required: true }, { key: 'tax_id', label: '統一編號' },
    { key: 'bank', label: '銀行' }, { key: 'account', label: '匯款帳號' }, { key: 'address', label: '地址' },
  ],
  applicants: [
    { key: 'employee_no', label: '員工編號' }, { key: 'name', label: '姓名', required: true }, { key: 'phone', label: '電話' },
  ],
  sites: [
    { key: 'name', label: '案場名稱', required: true }, { key: 'address', label: '地址' },
    { key: 'scope', label: '承包項目' }, { key: 'supervisor', label: '負責工地主任' },
  ],
};
const MASTER_TITLE = { counterparties: '廠商／客戶', companies: '公司', applicants: '申請人', sites: '案場' };

function bindMasters() {
  document.querySelectorAll('.sub-tab[data-master]').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t === tab));
    masterType = tab.dataset.master;
    renderMasterTable();
  }));
  document.getElementById('master-add').addEventListener('click', () => openMasterModal(null));
  document.getElementById('master-cancel').addEventListener('click', () => {
    document.getElementById('master-modal').style.display = 'none';
  });
  document.getElementById('master-save').addEventListener('click', saveMaster);
}

function renderMasterTable() {
  document.getElementById('master-title').textContent = MASTER_TITLE[masterType];
  const fields = MASTER_FIELDS[masterType];
  const rows = masters[masterType] || [];
  document.getElementById('master-table').innerHTML = `
    <thead><tr>${fields.map((f) => `<th>${f.label}</th>`).join('')}<th>狀態</th><th>操作</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.active === false ? 'row-off' : ''}">
      ${fields.map((f) => `<td>${escapeHtml(displayValue(f, r[f.key]))}</td>`).join('')}
      <td>${r.active === false ? '停用' : '使用中'}</td>
      <td><button class="icon-btn m-edit" data-id="${r.id}">✎</button>
          <button class="icon-btn m-toggle" data-id="${r.id}">${r.active === false ? '啟用' : '停用'}</button></td>
    </tr>`).join('')}</tbody>`;

  document.querySelectorAll('.m-edit').forEach((b) => b.addEventListener('click', () => {
    openMasterModal(masters[masterType].find((x) => x.id === +b.dataset.id));
  }));
  document.querySelectorAll('.m-toggle').forEach((b) => b.addEventListener('click', async () => {
    try {
      await Api.put(`/api/masters/${masterType}/${b.dataset.id}/toggle`, {});
      await loadMasters(); renderMasterTable();
    } catch (err) { showToast(err.message, 'error'); }
  }));
}

function displayValue(field, value) {
  if (field.type === 'select') {
    const hit = field.options.find((o) => o[0] === value);
    return hit ? hit[1] : (value || '');
  }
  return value === null || value === undefined ? '' : String(value);
}

function openMasterModal(row) {
  masterEditing = row;
  document.getElementById('master-modal-title').textContent = `${row ? '編輯' : '新增'}${MASTER_TITLE[masterType]}`;
  document.getElementById('master-form').innerHTML = MASTER_FIELDS[masterType].map((f) => {
    const val = row ? (row[f.key] ?? '') : '';
    if (f.type === 'select') {
      return `<div class="field"><label>${f.label}</label><select data-key="${f.key}">
        ${f.options.map((o) => `<option value="${o[0]}" ${o[0] === val ? 'selected' : ''}>${o[1]}</option>`).join('')}
      </select></div>`;
    }
    return `<div class="field"><label class="${f.required ? 'req' : ''}">${f.label}</label>
      <input type="text" data-key="${f.key}" value="${escapeAttr(val)}"></div>`;
  }).join('');
  document.getElementById('master-modal').style.display = 'flex';
}

async function saveMaster() {
  const payload = {};
  document.querySelectorAll('#master-form [data-key]').forEach((el) => { payload[el.dataset.key] = el.value.trim(); });
  try {
    if (masterEditing) await Api.put(`/api/masters/${masterType}/${masterEditing.id}`, payload);
    else await Api.post(`/api/masters/${masterType}`, payload);
    document.getElementById('master-modal').style.display = 'none';
    showToast('已儲存', 'success');
    await loadMasters();
    renderMasterTable();
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// 操作紀錄
// ============================================================
async function loadLogs() {
  try {
    const rows = await Api.get('/api/logs');
    document.getElementById('logs-table').innerHTML = `
      <thead><tr><th>時間</th><th>動作</th><th>內容</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r.time_fmt}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.detail || '')}</td></tr>`).join('')}</tbody>`;
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// 工具
// ============================================================
function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}
function currentMonth() { return today().slice(0, 7); }
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
