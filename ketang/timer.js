// 倒计时引擎：剩余 = 开始时剩余 - (now() - 开始时刻)，不靠 setInterval 累加；不碰 DOM、不存储。
//
// 可测试性：时钟 now 可注入；定时器可注入 setIntervalFn / clearIntervalFn（默认取 globalThis 的，
// 调用时才取，导入本模块不会启动任何东西）。测试也可以直接调用公开的 tick()，效果等同一次定时回调。
//
// 回调：onTick(剩余毫秒) 在每次 tick、以及 set/start/pause/reset/resync 后调用，供 UI 刷新；
//       onDone() 走到 0 时只调用一次，并自动停止。
// 到 0 之后再 start()：从上次 set 的时长重新开始（规格 3.1「再点开始从上次预设重新开始」）。
// resync()：给 visibilitychange 用，切后台回来立刻按真实时间校正（过点了就当场触发 onDone）。

export function createTimer({
  now = () => performance.now(),
  onTick,
  onDone,
  tickMs = 200,
  setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
} = {}) {
  let durationMs = 0;        // 上次 set 的时长
  let remainingAtStart = 0;  // 暂停/未开始时的剩余，运行中为本段开始时的剩余
  let startAt = 0;
  let running = false;
  let handle = null;

  const notify = (ms) => { if (onTick) onTick(ms); };

  function stopInterval() {
    if (handle !== null) { clearIntervalFn(handle); handle = null; }
  }

  function remainingMs() {
    if (!running) return remainingAtStart;
    return Math.max(0, remainingAtStart - (now() - startAt));
  }

  function tick() {
    if (!running) return;
    const ms = remainingMs();
    if (ms <= 0) {
      running = false;
      remainingAtStart = 0;
      stopInterval();
      notify(0);
      if (onDone) onDone();
      return;
    }
    notify(ms);
  }

  function set(sec) {
    const n = Number(sec);
    running = false;
    stopInterval();
    durationMs = Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
    remainingAtStart = durationMs;
    notify(remainingAtStart);
  }

  function start() {
    if (running) return;
    if (remainingAtStart <= 0) remainingAtStart = durationMs; // 到 0 后重新开始
    if (remainingAtStart <= 0) return;                         // 没设过时长
    startAt = now();
    running = true;
    handle = setIntervalFn(tick, tickMs);
    notify(remainingAtStart);
  }

  function pause() {
    if (!running) return;
    remainingAtStart = remainingMs();
    running = false;
    stopInterval();
    notify(remainingAtStart);
  }

  function reset() {
    running = false;
    stopInterval();
    remainingAtStart = durationMs;
    notify(remainingAtStart);
  }

  // 运行中按真实时间重算（可能当场到 0）；暂停时只刷新一次显示
  function resync() {
    if (running) tick();
    else notify(remainingAtStart);
  }

  return {
    set, start, pause, reset, resync, tick, remainingMs,
    get running() { return running; },
    get durationMs() { return durationMs; },
  };
}
