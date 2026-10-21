// app/env.js
// 微信、小红书的内置浏览器：不能下载文件，备份改走复制粘贴
export function isInAppBrowser(ua = "") {
  return /MicroMessenger|xhsdiscover|XiaoHongShu/i.test(String(ua));
}
