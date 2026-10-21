// 朗读封装：只碰浏览器的 speechSynthesis。所有全局访问都放在函数里，Node 下导入不会报错。

export function canSpeak() {
  return typeof globalThis.speechSynthesis !== "undefined"
    && typeof globalThis.SpeechSynthesisUtterance !== "undefined";
}

// 先停掉正在读的，再读新的
export function speak(text, lang = "zh-CN") {
  if (!canSpeak() || !text) return;
  try {
    globalThis.speechSynthesis.cancel();
    const u = new globalThis.SpeechSynthesisUtterance(String(text));
    u.lang = lang;
    globalThis.speechSynthesis.speak(u);
  } catch {
    // 个别浏览器实现不全，朗读失败不影响主流程
  }
}

export function stopSpeaking() {
  if (!canSpeak()) return;
  try { globalThis.speechSynthesis.cancel(); } catch { /* 忽略 */ }
}
