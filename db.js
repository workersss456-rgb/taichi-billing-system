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

  await seedMasters();
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
