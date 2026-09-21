const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const connectionString = config.databaseUrl;
if (!connectionString) {
  console.error('🚨 尚未設定 DATABASE_URL，請在環境變數填入 Neon 連線字串。');
}

const pool = new Pool({
  connectionString,
  // Neon 需要 SSL；本機測試用的 localhost 資料庫則不用
  ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString || '') ? false : { rejectUnauthorized: false },
});

async function init() {
  // ---------- 主檔 ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      tax_id TEXT,
      bank TEXT,
      account TEXT,
      address TEXT,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    -- 廠商與客戶放同一張表，用 role 區分（有些公司兩種身分都有）
    CREATE TABLE IF NOT EXISTS counterparties (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT DEFAULT 'vendor',           -- vendor 廠商 / customer 客戶 / both
      tax_id TEXT,
      bank TEXT,
      account TEXT,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS applicants (
      id SERIAL PRIMARY KEY,
      employee_no TEXT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT,
      scope TEXT,                            -- 承包項目
      supervisor TEXT,                       -- 負責工地主任
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );
  `);

  // ---------- 申請單 ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      doc_no TEXT UNIQUE,                    -- B-2026-0001 請款 / P-2026-0001 付款
      kind TEXT NOT NULL,                    -- billing 請款(應收) / payment 付款(應付)
      request_type TEXT NOT NULL,            -- 一般工程款 / 點工費用 / 材料採購 / 零用金核銷
      company_id INTEGER REFERENCES companies(id),
      company_name TEXT,                     -- 快照
      counterparty_id INTEGER REFERENCES counterparties(id),
      counterparty_name TEXT,                -- 快照
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      applicant_id INTEGER REFERENCES applicants(id),
      applicant_name TEXT,
      invoice_no TEXT,                       -- 可重複（收據、免用發票都算）
      invoice_date DATE,
      is_tax_free BOOLEAN DEFAULT false,
      subtotal NUMERIC(14,2) DEFAULT 0,      -- 未稅
      tax NUMERIC(14,2) DEFAULT 0,
      total NUMERIC(14,2) DEFAULT 0,         -- 含稅
      retention_amount NUMERIC(14,2) DEFAULT 0,   -- 保留款
      deduction_amount NUMERIC(14,2) DEFAULT 0,   -- 扣款
      deduction_note TEXT,
      prepaid_offset NUMERIC(14,2) DEFAULT 0,     -- 預付沖抵
      net_amount NUMERIC(14,2) DEFAULT 0,         -- 淨額 = 含稅 - 保留 - 扣款 - 預付
      bank_name TEXT,                        -- 收款帳戶快照
      bank_account TEXT,
      due_date DATE,                         -- 預計撥款／收款日
      status TEXT DEFAULT 'draft',
      note TEXT,
      voided BOOLEAN DEFAULT false,
      void_reason TEXT,
      voided_at TIMESTAMPTZ,
      order_id INTEGER,                      -- 預留：未來對應叫料系統的單號
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS request_items (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      quantity NUMERIC(12,2) DEFAULT 1,
      unit TEXT DEFAULT '式',
      unit_price NUMERIC(14,2) DEFAULT 0,
      subtotal NUMERIC(14,2) DEFAULT 0,      -- 未稅小計
      total NUMERIC(14,2) DEFAULT 0,         -- 含稅
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS request_photos (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      file_name TEXT,
      data TEXT NOT NULL,                    -- 前端壓縮後的 data URL
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 收付紀錄：一張單可以分多次撥款／收款，「付一半」用這張表表達
    CREATE TABLE IF NOT EXISTS settlements (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      paid_date DATE NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      bank TEXT,
      method TEXT DEFAULT '匯款',            -- 匯款 / 支票 / 現金 / 抵扣
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      request_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_requests_kind_status ON requests (kind, status);
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_request ON request_items (request_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_request ON settlements (request_id);
  `);

  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS legacy_key TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_legacy_key ON requests (legacy_key) WHERE legacy_key IS NOT NULL`);

  await seedMasters();
  await importLegacy();
}

// ============================================================
// 舊系統（Google 試算表）資料匯入
// 每次啟動都會檢查 seeds/legacy.json；已經匯過的單（legacy_key 相同）直接跳過，
// 所以之後把試算表重新匯出一次、更新 legacy.json 再部署，只會補進新增的單，不會重複。
// ============================================================
const LEGACY_STATUS = {
  // 舊「撥款狀態」 → 新狀態（付款單／請款單）
  待處理: { payment: 'pending_approval', billing: 'pending_approval' },
  待撥款: { payment: 'scheduled', billing: 'invoiced' },
  延遲付款: { payment: 'scheduled', billing: 'invoiced' },
  付一半: { payment: 'partial', billing: 'partial' },
  已撥款: { payment: 'settled', billing: 'settled' },
};

async function importLegacy() {
  const file = path.join(__dirname, 'seeds', 'legacy.json');
  if (!fs.existsSync(file)) return;
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (legacy.requests || []).slice().sort((a, b) => (a.created || '').localeCompare(b.created || ''));

  const existing = new Set((await pool.query('SELECT legacy_key FROM requests WHERE legacy_key IS NOT NULL')).rows.map((r) => r.legacy_key));
  const todo = list.filter((q) => !existing.has(q.key));
  if (!todo.length) return;

  const client = await pool.connect();
  const stats = { requests: 0, items: 0, settlements: 0, newParties: 0, newSites: 0, newApplicants: 0 };
  try {
    await client.query('BEGIN');
    const companies = (await client.query('SELECT * FROM companies')).rows;

    async function findOrCreate(table, name, extra) {
      if (!name) return null;
      const hit = (await client.query(`SELECT * FROM ${table} WHERE name = $1`, [name])).rows[0];
      if (hit) return hit;
      const cols = ['name', ...Object.keys(extra || {})];
      const vals = [name, ...Object.values(extra || {})];
      const row = (await client.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals
      )).rows[0];
      if (table === 'counterparties') stats.newParties++;
      if (table === 'sites') stats.newSites++;
      if (table === 'applicants') stats.newApplicants++;
      return row;
    }

    // 舊單號獨立編：OLD-P-0001、OLD-B-0001，不會跟新系統的 P-2026-xxxx 流水號打架
    const seq = {};
    for (const k of ['P', 'B']) {
      const last = (await client.query(`SELECT doc_no FROM requests WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [`OLD-${k}-%`])).rows[0];
      seq[k] = last ? Number(last.doc_no.split('-')[2]) : 0;
    }

    for (const q of todo) {
      const company = companies.find((c) => c.name === q.company) || companies[0];
      const party = await findOrCreate('counterparties', q.counterparty, { role: q.kind === 'billing' ? 'customer' : 'vendor' });
      const site = await findOrCreate('sites', q.site, {});
      const applicant = await findOrCreate('applicants', q.applicant, {});

      const total = Math.round(Number(q.total) || 0);
      const subtotal = q.tax_free ? total : Math.round(total / 1.05);
      const status = (LEGACY_STATUS[q.pay_status] || LEGACY_STATUS['待處理'])[q.kind];
      const prefix = q.kind === 'billing' ? 'B' : 'P';
      seq[prefix] += 1;
      const docNo = `OLD-${prefix}-${String(seq[prefix]).padStart(4, '0')}`;

      const noteParts = [];
      if (q.note) noteParts.push(q.note);
      noteParts.push(`【舊系統匯入】原申請類型：${q.legacy_type || '—'}；原撥款狀態：${q.pay_status}`);
      if (q.pay_status === '延遲付款') noteParts.push('⚠️ 舊系統標示為延遲付款');
      if (q.pay_status === '付一半') noteParts.push('⚠️ 舊系統只標「付一半」，已付金額以 50% 推估登記，請核對實際撥款');

      const bankSrc = q.kind === 'billing' ? company : party;
      const row = (await client.query(
        `INSERT INTO requests (
           doc_no, kind, request_type, company_id, company_name, counterparty_id, counterparty_name,
           site_id, site_name, applicant_id, applicant_name, invoice_no, invoice_date, is_tax_free,
           subtotal, tax, total, net_amount, bank_name, bank_account, due_date, status, note,
           created_at, updated_at, legacy_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20,$21,$22,
           ($23::date + TIME '09:00') AT TIME ZONE 'Asia/Taipei', NOW(), $24)
         RETURNING id`,
        [
          docNo, q.kind, q.request_type, company ? company.id : null, company ? company.name : q.company,
          party ? party.id : null, q.counterparty, site ? site.id : null, q.site || '',
          applicant ? applicant.id : null, q.applicant || '', q.invoice_no || '', q.invoice_date || null, !!q.tax_free,
          subtotal, total - subtotal, total,
          q.bank || (bankSrc && bankSrc.bank) || '', q.account || (bankSrc && bankSrc.account) || '',
          q.due_date || null, status, noteParts.join('\n'), q.created || q.invoice_date || new Date().toISOString().slice(0, 10), q.key,
        ]
      )).rows[0];

      const items = q.items && q.items.length ? q.items
        : [{ name: '（舊資料未附明細）', qty: 1, unit: '式', price: subtotal, subtotal, total }];
      for (const [i, it] of items.entries()) {
        const sub = Math.round(Number(it.subtotal) || 0);
        const tot = Math.round(Number(it.total) || (q.tax_free ? sub : sub * 1.05));
        await client.query(
          `INSERT INTO request_items (request_id, item_name, quantity, unit, unit_price, subtotal, total, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.id, it.name, Number(it.qty) || 1, it.unit || '式', Number(it.price) || 0, sub, tot, i]
        );
        stats.items++;
      }

      // 已撥款／付一半：補一筆收付紀錄，已付與未付才算得出來
      if (q.pay_status === '已撥款' || q.pay_status === '付一半') {
        const amount = q.pay_status === '已撥款' ? total : Math.round(total / 2);
        const paidDate = q.paid_date || q.due_date || q.created || q.invoice_date;
        await client.query(
          `INSERT INTO settlements (request_id, paid_date, amount, bank, method, note) VALUES ($1,$2,$3,$4,'匯款',$5)`,
          [row.id, paidDate, amount, q.settle_bank || '',
            q.pay_status === '付一半' ? '舊系統「付一半」推估金額，請核對' : (q.paid_date ? '舊系統匯入' : '舊系統匯入（實際撥款日不詳，以預計撥款日登記）')]
        );
        stats.settlements++;
      }
      stats.requests++;
    }

    await client.query('INSERT INTO audit_logs (action, detail) VALUES ($1,$2)', [
      '舊系統資料匯入',
      `申請單 ${stats.requests}、明細 ${stats.items}、收付紀錄 ${stats.settlements}；新增廠商/客戶 ${stats.newParties}、案場 ${stats.newSites}、申請人 ${stats.newApplicants}`,
    ]);
    await client.query('COMMIT');
    console.log(`✅ 舊系統資料匯入：申請單 ${stats.requests}、明細 ${stats.items}、收付紀錄 ${stats.settlements}（新增對象 ${stats.newParties}、案場 ${stats.newSites}、申請人 ${stats.newApplicants}）`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('🚨 舊系統資料匯入失敗（系統照常啟動，資料未寫入）：', err.message);
  } finally {
    client.release();
  }
}

// 第一次啟動時，把現行試算表的主檔匯入（之後在後台維護，不再覆蓋）
async function seedMasters() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM companies');
  if (rows[0].c > 0) return;

  const file = path.join(__dirname, 'seeds', 'masters.json');
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, c] of seed.companies.entries()) {
      await client.query(
        `INSERT INTO companies (name, tax_id, bank, account, address, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (name) DO NOTHING`,
        [c.name, c.tax_id, c.bank, c.account, c.address, i]
      );
    }
    for (const [i, v] of seed.vendors.entries()) {
      await client.query(
        `INSERT INTO counterparties (name, role, tax_id, bank, account, contact_person, phone, address, sort_order)
         VALUES ($1,'vendor',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (name) DO NOTHING`,
        [v.name, v.tax_id, v.bank, v.account, v.contact_person, v.phone, v.address, i]
      );
    }
    for (const [i, a] of seed.applicants.entries()) {
      await client.query(
        `INSERT INTO applicants (employee_no, name, phone, sort_order)
         VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`,
        [a.employee_no, a.name, a.phone, i]
      );
    }
    for (const [i, s] of seed.sites.entries()) {
      await client.query(
        `INSERT INTO sites (name, address, scope, supervisor, sort_order)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING`,
        [s.name, s.address, s.scope, s.supervisor, i]
      );
    }
    await client.query('COMMIT');
    console.log(`✅ 已匯入主檔：公司 ${seed.companies.length}、廠商 ${seed.vendors.length}、申請人 ${seed.applicants.length}、案場 ${seed.sites.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
