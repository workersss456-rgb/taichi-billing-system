// 共用 API 呼叫：自動帶上系統密碼，並把後端的錯誤訊息轉成 Error
const Api = {
  headers() {
    return { 'Content-Type': 'application/json', 'x-app-password': sessionStorage.getItem('appPassword') || '' };
  },
  async request(method, url, body) {
    const opt = { method, headers: Api.headers() };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 沒有 JSON 內容 */ }
    if (!res.ok) throw new Error((data && data.error) || `伺服器錯誤（${res.status}）`);
    return data;
  },
  get: (url) => Api.request('GET', url),
  post: (url, body) => Api.request('POST', url, body),
  put: (url, body) => Api.request('PUT', url, body),
  del: (url) => Api.request('DELETE', url),
};
