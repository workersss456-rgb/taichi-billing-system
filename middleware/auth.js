const config = require('../config');

// 第一階段：單一密碼。第四階段會換成個人帳號 + 角色權限
module.exports = function auth(req, res, next) {
  const pw = req.get('x-app-password') || '';
  if (pw !== config.adminPassword) {
    return res.status(401).json({ error: '密碼錯誤或尚未登入' });
  }
  next();
};
