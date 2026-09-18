const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const api = require('./routes/api');
const front = require('./routes/front');

const app = express();
// 照片會以 base64 夾在 JSON 裡送上來，所以放寬上限
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/f', front);   // 前台：手機辨識，不含財務欄位
app.use('/api', api);       // 後台：需要密碼

db.init()
  .then(() => {
    app.listen(config.port, () => console.log(`請款付款系統已啟動：http://localhost:${config.port}`));
  })
  .catch((err) => {
    console.error('🚨 資料庫初始化失敗，伺服器無法啟動：', err.message);
    process.exit(1);
  });
