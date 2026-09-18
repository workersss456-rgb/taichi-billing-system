// 設定來源：環境變數優先（Render 用），本機開發可用預設值
module.exports = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL || '',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-please',
};
