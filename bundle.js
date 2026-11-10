(function(){'use strict';const modules={"preview/entry.js":function(require,module,exports){
const { createGame } = require('../src/game');
const { createBrowserPlatform } = require('./platform-browser');

const game = createGame(createBrowserPlatform(document.getElementById('game')));
// 只读观测接口，测试必须通过真实指针操作，不能修改游戏状态。
window.__gameSnapshot = () => game.getSnapshot();
game.start().catch(() => {
  const message = document.createElement('p');
  message.textContent = '暂时无法打开冒险，请刷新后再试。';
  message.className = 'startup-error'; document.body.appendChild(message);
});
window.addEventListener('pagehide', event => {
  // BFCache 会保留此入口；可见性恢复时由平台适配器继续运行。
  if (!event.persisted) game.destroy();
});

},
"src/game.js":function(require,module,exports){
const model = require("./model");
const challenges = require("./challenges");
const { localDate } = require("./calendar");
const {
  WIDTH,
  HEIGHT,
  UI,
  DAYS,
  viewportTransform,
  toLogical,
  contains,
} = require("./layout");
const { layoutFor } = require("./challenge-layout");
const { render } = require("./draw");
const {characterRect}=require('./character-motion');
const { createFeedback, actionFeedback } = require("./feedback");
function createGame(platform) {
  const today = () => (platform.today ? platform.today() : localDate());
  let state;
  try {
    state = model.restore(platform.load(), today());
  } catch (_) {
    state = model.initialState();
  }
  let viewport,
    frame = null,
    lastDraw = -Infinity,
    hidden = false,
    destroyed = false,
    ready = false,
    error = false,
    loading = false,
    started = false;
  let selected = null,
    pointer = null,
    parentStarted = null,
    parentAction = null,
    message = "",
    messageUntil = 0,
    generation = 0,
    demoStart = 0,
    mismatchUntil = 0,
    peekUntil = 0,
    demoToneStep = -1,
    checkinPlayedFor = -1;
  let characterEpoch = 0;
  const images = {}, imageRequests = {},
    unsubscribe = [];
  const now = () => platform.now(),
    copy = (v) => JSON.parse(JSON.stringify(v));
  const feedback = createFeedback(now);
  const level = () => model.currentLevel(state),
    layout = () => layoutFor(level());
  const visibleImage = () => ["goodnight", "ended"].includes(state.scene) ? "bedtime" : "adventure";
  const canParentContinue = () =>
    model.needsParent(state) &&
    ["home", "goodnight", "ended"].includes(state.scene);
  function clearPointer() {
    pointer = null;
    parentStarted = null;
    parentAction = null;
  }
  function resetTemporal() {
    characterEpoch = now();
    demoStart = now() + 900;
    mismatchUntil = 0;
    peekUntil = 0;
    demoToneStep = -1;
  }
  function clearFeedback() {
    feedback.clear();
    if (platform.stopEffects) platform.stopEffects();
  }
  function effect(key, delay = 0) {
    if (!hidden && !destroyed && !state.muted && state.scene !== "ended")
      feedback.sound(key, delay);
  }
  function flushEffects() {
    const sounds = feedback.drainSounds();
    if (hidden || destroyed || state.muted || state.scene === "ended") return;
    sounds.forEach((key) => {
      if (key === "checkin") checkinPlayedFor = state.day;
      if (platform.playEffect) {
        try {
          platform.playEffect(key);
        } catch (_) {}
      }
    });
  }
  function animateAction(old, next, action, map, meta) {
    if (old.scene !== "play" || action.type !== "challenge") return;
    const result = actionFeedback(
      model.currentLevel(old),
      old.challenge,
      next.challenge,
      action.action,
      map,
      meta,
    );
    result.events.forEach((e) =>
      feedback.add(e.kind, e.data, e.duration, e.delay),
    );
    result.sounds.forEach((key, index) => effect(key, index * 120));
    if (model.progress(next) > model.progress(old))
      feedback.add('character', {action:'cheer'}, 1200);
    if (!model.isComplete(old) && model.isComplete(next)) {
      const last = model.currentLevel(old).index === 19;
      feedback.add(
        "celebrate",
        { text: last ? "打卡成功，晚安！" : "小铭，做得好！" },
        1200,
      );
      if (last) {
        feedback.add("stamp", {}, 1000, 300);
        effect("checkin", 450);
      } else effect("win", 160);
    }
  }
  function activeColor() {
    if (
      state.scene !== "play" ||
      level().type !== "sequence" ||
      state.challenge.mode !== "demo"
    )
      return null;
    const elapsed = now() - demoStart,
      index = Math.floor(elapsed / 850);
    return elapsed >= 0 &&
      index < level().sequence.length &&
      elapsed % 850 < 600
      ? level().sequence[index]
      : null;
  }
  function draw() {
    if (destroyed || !viewport || hidden) return;
    const ctx = platform.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#b8c1e8";
    ctx.fillRect(0, 0, platform.canvas.width, platform.canvas.height);
    ctx.setTransform(
      viewport.scale * viewport.dpr,
      0,
      0,
      viewport.scale * viewport.dpr,
      viewport.x * viewport.dpr,
      viewport.y * viewport.dpr,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WIDTH, HEIGHT);
    ctx.clip();
    const visualFeedback = feedback.snapshot();
    const enter = visualFeedback.events.find((e) => e.kind === "enter");
    ctx.globalAlpha = 1;
    render(ctx, state, {
      images,
      time: now(),
      characterTime: now() - characterEpoch,
      audio: audioState(),
      today: today(),
      layout: layout(),
      selected,
      drag: pointer && pointer.index != null ? pointer : null,
      parentHold:
        parentStarted === null
          ? 0
          : Math.min(1, (now() - parentStarted) / 2000),
      parentAction,
      message: now() < messageUntil ? message : "",
      loading,
      error,
      peek: now() < peekUntil,
      activeColor: activeColor(),
      feedback: visualFeedback,
      still: state.scene === "ended",
    });
    // 先完整合成场景，再淡出统一遮罩，避免月牙等遮盖图形出现叠影。
    if (enter) {
      ctx.globalAlpha = 0.35 * (1 - enter.progress);
      ctx.fillStyle = "#b8c1e8";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    ctx.restore();
  }
  function resize() {
    viewport = viewportTransform(platform.getViewport());
    platform.canvas.width = Math.round(viewport.width * viewport.dpr);
    platform.canvas.height = Math.round(viewport.height * viewport.dpr);
    draw();
  }
  function stopLoop() {
    if (frame !== null) platform.cancelFrame(frame);
    frame = null;
  }
  function schedule() {
    if (
      frame === null &&
      !hidden &&
      !destroyed &&
      (state.scene !== "ended" || parentStarted !== null)
    )
      frame = platform.requestFrame(tick);
  }
  function tick() {
    frame = null;
    if (destroyed || hidden) return;
    if (parentStarted !== null && now() - parentStarted >= 2000) {
      const action = parentAction;
      clearPointer();
      selected = null;
      change({ type: action });
    }
    if (state.scene === "play" && !model.isComplete(state)) {
      if (level().type === "sequence" && state.challenge.mode === "demo") {
        const elapsed = now() - demoStart,
          index = Math.floor(elapsed / 850),
          color = activeColor();
        if (color && index !== demoToneStep) {
          demoToneStep = index;
          effect("note-" + color);
        }
      }
      if (
        level().type === "sequence" &&
        state.challenge.mode === "demo" &&
        now() >= demoStart + level().sequence.length * 850
      )
        change({ type: "challenge", action: { type: "demoDone" } });
      if (
        level().type === "memory" &&
        state.challenge.open.length === 2 &&
        mismatchUntil &&
        now() >= mismatchUntil
      )
        change({ type: "challenge", action: { type: "close" } });
    }
    flushEffects();
    if (now() - lastDraw >= 30) {
      draw();
      lastDraw = now();
    }
    schedule();
  }
  function speak() {
    if (!hidden && !state.muted && state.scene !== "ended")
      platform.playAudio(model.voiceKey(state));
  }
  function audioState() {
    return platform.getAudioState ? platform.getAudioState() : {status:'ready'};
  }
  function toggleSound(status=audioState().status) {
    if (!state.muted && ['locked','blocked','error','unlocking'].includes(status) && platform.unlockAudio) {
      platform.unlockAudio();
      // 点击意图立即进入播放器队列；兼容事件可能替换尚未结束的解锁请求。
      speak();
      draw(); return;
    }
    change({type:'mute'});
  }
  function change(action, meta = {}) {
    const old = state,
      next = model.reduce(state, action, today());
    const oldMap = layout();
    if (next === old) {
      animateAction(old, next, action, oldMap, meta);
      flushEffects();
      return false;
    }
    state = next;
    try {
      platform.save(state);
    } catch (_) {}
    const moved =
      old.scene !== state.scene ||
      model.currentLevel(old).id !== level().id ||
      old.day !== state.day;
    if (moved) {
      clearFeedback();
      clearPointer();
      selected = null;
      messageUntil = 0;
      resetTemporal();
      if (state.scene !== "ended") feedback.add("enter", {}, 350);
      if (state.scene === "goodnight") {
        feedback.add("stamp", {}, 1000);
        if (checkinPlayedFor !== state.day) effect("checkin");
      }
    }
    if (action.type === "reset") checkinPlayedFor = -1;
    animateAction(old, next, action, oldMap, meta);
    if (state.scene === "play") {
      if (
        level().type === "sequence" &&
        state.challenge.mode === "demo" &&
        (moved ||
          (action.action && ["replay", "color"].includes(action.action.type)))
      ) {
        demoStart = now() + 900;
        demoToneStep = -1;
      }
      if (level().type === "memory")
        mismatchUntil = state.challenge.open.length === 2 ? now() + 850 : 0;
    }
    if (!images[visibleImage()]) {
      platform.stopAudio();
      loadImages(true);
      return true;
    }
    if (state.muted || state.scene === "ended") {
      feedback.clearSounds();
      platform.stopAudio();
    } else if (
      moved ||
      action.type === "mute" ||
      (state.scene === "play" &&
        ((level().type === "care" &&
          old.challenge &&
          old.challenge.step !== state.challenge.step) ||
          (!model.isComplete(old) && model.isComplete(state))))
    )
      speak();
    if (state.scene === "ended") {
      clearFeedback();
      stopLoop();
    }
    flushEffects();
    draw();
    schedule();
    return true;
  }
  function hint(text) {
    message = text;
    messageUntil = now() + 1700;
    draw();
  }
  function sourceAt(point) {
    if (state.scene !== "play" || model.isComplete(state)) return null;
    const l = level(),
      c = state.challenge;
    if (["bridge", "sort"].includes(l.type)) {
      const r = layout().items.find(
        (x) => !c.placed.includes(x.index) && contains(x, point),
      );
      return r ? r.index : null;
    }
    if (l.type === "care" && c.step < 2)
      return contains(layout().items[c.step], point, 8) ? c.step : null;
    return null;
  }
  function place(index, point, from = null) {
    const l = level(),
      map = layout(),
      item = map.items[index];
    let ok = false;
    if (!item) return false;
    const candidates = map.targets
      .filter((r) => contains(r, point, 18))
      .sort(
        (a, b) =>
          Math.hypot(point.x - a.x - a.w / 2, point.y - a.y - a.h / 2) -
          Math.hypot(point.x - b.x - b.w / 2, point.y - b.y - b.h / 2),
      );
    const target = candidates[0];
    if (target && ["bridge", "sort"].includes(l.type))
      ok = change(
        {
          type: "challenge",
          action: { type: "place", index, target: target.value },
        },
        { from },
      );
    if (target && l.type === "care" && target.value === item.value)
      ok = change(
        {
          type: "challenge",
          action: { type: "care", item: item.value },
        },
        { from },
      );
    if (
      !ok &&
      (!target || (l.type === "care" && target.value !== item.value))
    ) {
      const result = actionFeedback(
        l,
        state.challenge,
        state.challenge,
        { type: "place", index, target: target && target.value },
        map,
        { from },
      );
      result.events.forEach((e) =>
        feedback.add(e.kind, e.data, e.duration, e.delay),
      );
      result.sounds.forEach((key) => effect(key));
      flushEffects();
    }
    selected = null;
    if (!ok)
      hint(
        l.type === "care"
          ? "放到伙伴的床上试试吧！"
          : "找一找，相同的图案在哪里？",
      );
    return ok;
  }
  function click(point, audioStatusAtPress) {
    if (error) {
      if (contains(UI.retry, point)) loadImages(true);
      return;
    }
    if (
      !ready ||
      !point ||
      contains(UI.parent, point) ||
      (canParentContinue() && contains(UI.parentNext, point))
    )
      return;
    if (state.scene !== 'ended' && contains(characterRect(state.scene), point)) {
      feedback.add('character', {action:'wave'}, 1800);
      if(state.scene==='home'||state.scene==='play')feedback.add('greet',{text:'嗨，小铭！'},1800);
      effect('tap'); flushEffects(); draw(); schedule();
      return;
    }
    if (state.scene === "home") {
      if (contains(UI.mute, point)) {
        toggleSound(audioStatusAtPress);
        return;
      }
      const card = DAYS.find((r) => contains(r, point));
      if (card) {
        if (!change({ type: "start", day: card.day }))
          hint(
            model.needsParent(state)
              ? "请家长长按开启下一组"
              : "先完成前一组冒险吧",
          );
        return;
      }
      if (contains(UI.start, point)) change({ type: "start" });
      return;
    }
    if (state.scene === "goodnight") {
      if (contains(UI.end, point)) change({ type: "end" });
      return;
    }
    if (state.scene === "ended") return;
    if (contains(UI.back, point)) {
      change({ type: "home" });
      return;
    }
    if (contains(UI.mute, point)) {
      toggleSound(audioStatusAtPress);
      return;
    }
    if (model.isComplete(state)) {
      if (contains(UI.next, point)) change({ type: "next" });
      return;
    }
    if (contains(UI.speaker, point)) {
      if (state.muted) change({ type: "mute" });
      else speak();
      return;
    }
    const l = level(),
      map = layout();
    if (["sequence", "memory"].includes(l.type) && contains(map.help, point)) {
      effect("tap");
      flushEffects();
      if (l.type === "sequence") {
        change({ type: "challenge", action: { type: "replay" } });
        speak();
      } else {
        change({ type: "challenge", action: { type: "close" } });
        peekUntil = now() + 1800;
        draw();
      }
      return;
    }
    if (selected !== null) {
      place(selected, point);
      return;
    }
    const item = map.items.find((r) => contains(r, point));
    if (!item) return;
    let action;
    if (["find", "order"].includes(l.type))
      action = { type: "pick", index: item.index };
    if (l.type === "count") action = { type: "answer", value: item.value };
    if (l.type === "memory") {
      if (now() < peekUntil) return;
      action = { type: "flip", index: item.index };
    }
    if (l.type === "sequence") action = { type: "color", value: item.value };
    if (
      l.type === "care" &&
      state.challenge.step === 2 &&
      item.value === "lamp"
    )
      action = { type: "care", item: "lamp" };
    if (action) {
      const old = state;
      if (!change({ type: "challenge", action })) {
        if (
          !(
            l.type === "memory" ||
            (l.type === "sequence" && state.challenge.mode === "demo")
          )
        )
          hint("再仔细看一看，你可以的。");
      } else if (
        l.type === "sequence" &&
        state.challenge.mode === "demo" &&
        old.challenge.mode === "input"
      )
        hint("没关系，我们再看一次。");
    }
  }
  function input(e) {
    if (destroyed || hidden) return;
    const point = toLogical(viewport, e.x, e.y);
    if (e.type === "down") {
      if (pointer || !point) return;
      pointer = {
        id: e.id,
        audioStatus: audioState().status,
        startX: point.x,
        startY: point.y,
        x: point.x,
        y: point.y,
        index: ready ? sourceAt(point) : null,
        moved: false,
      };
      if (pointer.index !== null) feedback.removeIndex(pointer.index);
      if (ready && contains(UI.parent, point)) {
        parentStarted = now();
        parentAction = "reset";
        schedule();
      } else if (
        ready &&
        canParentContinue() &&
        (contains(UI.parentNext, point) ||
          (state.scene === "home" && contains(UI.start, point)))
      ) {
        parentStarted = now();
        parentAction = "parentContinue";
        schedule();
      }
      return;
    }
    if (!pointer || e.id !== pointer.id) return;
    if (e.type === "cancel") {
      clearPointer();
      selected = null;
      draw();
      return;
    }
    if (e.type === "move") {
      if (!point) {
        parentStarted = null;
        return;
      }
      pointer.x = point.x;
      pointer.y = point.y;
      if (Math.hypot(point.x - pointer.startX, point.y - pointer.startY) > 12)
        pointer.moved = true;
      const holdArea =
        parentAction === "parentContinue"
          ? contains(UI.start, { x: pointer.startX, y: pointer.startY }) &&
            state.scene === "home"
            ? UI.start
            : UI.parentNext
          : UI.parent;
      if (!contains(holdArea, point)) {
        parentStarted = null;
        parentAction = null;
      }
      draw();
      return;
    }
    if (e.type === "up") {
      const old = pointer,
        wasParent = parentStarted !== null;
      clearPointer();
      if (wasParent || !point) {
        draw();
        return;
      }
      if (old.index !== null) {
        if (old.moved) {
          const source = layout().items[old.index];
          place(old.index, point, {
            ...source,
            x: point.x - source.w / 2,
            y: point.y - source.h / 2,
          });
        } else {
          selected = selected === old.index ? null : old.index;
          if (selected !== null) {
            feedback.add(
              "pulse",
              { index: selected, rect: layout().items[selected] },
              260,
            );
            effect("tap");
            flushEffects();
          }
        }
      } else if (!old.moved) click(point, old.audioStatus);
      draw();
    }
  }
  function fetchImage(name) {
    if (images[name]) return Promise.resolve(images[name]);
    if (imageRequests[name]) return imageRequests[name];
    let request;
    try { request = Promise.resolve(platform.loadImage(`assets/${name}.png`)); }
    catch (error) { return Promise.reject(error); }
    const pending = request.then(image => {
      if (!destroyed) images[name] = image;
      delete imageRequests[name];
      return image;
    }, error => { delete imageRequests[name]; throw error; });
    imageRequests[name] = pending;
    return pending;
  }
  async function loadImages(announce = false) {
    clearFeedback();
    const token = ++generation;
    loading = true;
    error = false;
    ready = false;
    draw();
    schedule();
    try {
      const current = visibleImage();
      await fetchImage(current);
      if (destroyed || token !== generation) return;
      ready = true;
      characterEpoch = now();
      if (state.scene !== "ended") feedback.add("enter", {}, 350);
      if (state.scene === "goodnight") feedback.add("stamp", {}, 1000);
      if (announce) {
        speak();
        if (state.scene === "goodnight" && checkinPlayedFor !== state.day) effect("checkin");
        flushEffects();
      }
      // 当前画面可用后再预取另一套角色，失败留到需要时重试。
      fetchImage(current === "adventure" ? "bedtime" : "adventure").catch(() => {});
    } catch (_) {
      if (!destroyed && token === generation) error = true;
    }
    if (!destroyed && token === generation) {
      loading = false;
      draw();
    }
  }
  function hide() {
    hidden = true;
    clearFeedback();
    clearPointer();
    selected = null;
    stopLoop();
    platform.stopAudio();
  }
  function show() {
    if (destroyed) return;
    hidden = false;
    change({ type: "refresh" });
    if (state.scene === "play" && !model.isComplete(state)) {
      if (level().type === "memory")
        change({ type: "challenge", action: { type: "close" } });
      if (level().type === "sequence")
        change({ type: "challenge", action: { type: "replay" } });
    }
    resetTemporal();
    if (state.scene !== "ended") feedback.add("enter", {}, 350);
    resize();
    schedule();
  }
  return {
    async start() {
      if (started || destroyed) return;
      started = true;
      resize();
      unsubscribe.push(
        platform.onPointer(input),
        platform.onHide(hide),
        platform.onShow(show),
        platform.onResize(() => {
          clearPointer();
          selected = null;
          resize();
        }),
      );
      resetTemporal();
      await loadImages();
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearFeedback();
      generation++;
      stopLoop();
      platform.stopAudio();
      unsubscribe.forEach((fn) => {
        if (typeof fn === "function") fn();
      });
      if (platform.destroy) platform.destroy();
    },
    getState: () => copy(state),
    getSnapshot: () => ({
      state: copy(state),
      level: copy(level()),
      layout: copy(layout()),
      viewport: viewport && { ...viewport },
      ready,
      error,
      loadedImages: Object.keys(images),
      selected,
      hidden,
      today: today(),
      availableDay: model.availableDay(state, today()),
      demo: { activeColor: activeColor(), peek: now() < peekUntil },
      feedback: feedback.snapshot(),
      characterTime: now() - characterEpoch,
      audio: audioState(),
    }),
  };
}
module.exports = { createGame };

},
"src/model.js":function(require,module,exports){
const { LEVELS } = require("./levels");
const challenge = require("./challenges");
const { localDate, validDate } = require("./calendar");
function initialState() {
  return {
    v: 2,
    scene: "home",
    day: 0,
    completed: [0, 0, 0],
    stamps: [null, null, null],
    challenge: null,
    muted: false,
    endedDate: null,
    notice: false,
  };
}
function currentLevel(s) {
  return s.day >= 0 && s.day < 3
    ? LEVELS[s.day * 20 + Math.min(19, s.completed[s.day])]
    : null;
}
function availableDay(s) {
  const day = s.completed.findIndex((n) => n < 20);
  if (day < 0) return -1;
  return day === 0 || s.completed[day - 1] === 20 ? day : -1;
}
function needsParent(s) {
  return s.completed[s.day] === 20 && availableDay(s) > s.day;
}
function beginChapter(s, day) {
  const l = LEVELS[day * 20 + s.completed[day]];
  return {
    ...s,
    day,
    scene: "play",
    notice: false,
    endedDate: null,
    challenge:
      day === s.day && s.challenge
        ? challenge.resume(l, s.challenge)
        : challenge.initial(l),
  };
}
function progress(s) {
  const l = currentLevel(s);
  return s.challenge ? challenge.progress(l, s.challenge) : 0;
}
function goal(s) {
  return challenge.goal(currentLevel(s));
}
function isComplete(s) {
  return !!s.challenge && challenge.complete(currentLevel(s), s.challenge);
}
function reduce(s, a, today = localDate()) {
  if (a.type === "reset") return { ...initialState(), muted: s.muted };
  if (a.type === "mute") return { ...s, muted: !s.muted };
  // 一组结束后停留在晚安画面，由家长决定何时开始下一组。
  if (a.type === "parentContinue")
    return needsParent(s) && ["home", "goodnight", "ended"].includes(s.scene)
      ? beginChapter(s, availableDay(s))
      : s;
  if (a.type === "dismissNotice") return s.notice ? { ...s, notice: false } : s;
  if (s.scene === "ended") return s;
  if (a.type === "home") return { ...s, scene: "home" };
  if (a.type === "start" && s.scene === "home") {
    const day = availableDay(s, today);
    if (day < 0 || needsParent(s) || (a.day != null && a.day !== day)) return s;
    return beginChapter(s, day);
  }
  if (a.type === "end" && s.scene === "goodnight")
    return { ...s, scene: "ended", endedDate: today };
  if (s.scene !== "play") return s;
  if (a.type === "challenge") {
    const l = currentLevel(s),
      c = challenge.update(l, s.challenge, a.action);
    if (c === s.challenge) return s;
    if (s.completed[s.day] === 19 && challenge.complete(l, c)) {
      if (!validDate(today)) return s;
      const completed = s.completed.slice(),
        stamps = s.stamps.slice();
      completed[s.day] = 20;
      stamps[s.day] = today;
      return { ...s, challenge: c, completed, stamps };
    }
    return { ...s, challenge: c };
  }
  if (a.type === "next" && isComplete(s)) {
    if (s.completed[s.day] === 20) return { ...s, scene: "goodnight" };
    const completed = s.completed.slice();
    completed[s.day]++;
    if (completed[s.day] === 20) {
      const stamps = s.stamps.slice();
      stamps[s.day] = today;
      return { ...s, completed, stamps, challenge: null, scene: "goodnight" };
    }
    return {
      ...s,
      completed,
      challenge: challenge.initial(LEVELS[s.day * 20 + completed[s.day]]),
    };
  }
  return s;
}
function restore(raw, today = localDate()) {
  const fresh = initialState();
  if (raw && raw.v === 1)
    return { ...fresh, muted: raw.muted === true, notice: true };
  if (
    !raw ||
    raw.v !== 2 ||
    typeof raw.muted !== "boolean" ||
    !Number.isInteger(raw.day) ||
    raw.day < 0 ||
    raw.day > 2
  )
    return fresh;
  if (
    !Array.isArray(raw.completed) ||
    raw.completed.length !== 3 ||
    !raw.completed.every((n) => Number.isInteger(n) && n >= 0 && n <= 20) ||
    !Array.isArray(raw.stamps) ||
    raw.stamps.length !== 3
  )
    return fresh;
  for (let i = 0; i < 3; i++) {
    if (
      raw.completed[i] === 20
        ? !validDate(raw.stamps[i])
        : raw.stamps[i] !== null
    )
      return fresh;
    if (
      i > 0 &&
      raw.completed[i] > 0 &&
      (raw.completed[i - 1] !== 20 || !raw.stamps[i - 1])
    )
      return fresh;
  }
  const unfinished = raw.completed.findIndex((n) => n < 20);
  if (unfinished >= 0 && raw.day > unfinished) return fresh;
  if (
    raw.day < (unfinished < 0 ? 2 : unfinished) &&
    raw.completed[raw.day] !== 20
  )
    return fresh;
  let c = null;
  if (raw.challenge != null) {
    const l = LEVELS[raw.day * 20 + Math.min(19, raw.completed[raw.day])];
    if (raw.completed[raw.day] === 20 && !challenge.complete(l, raw.challenge))
      return fresh;
    if (!challenge.valid(l, raw.challenge)) return fresh;
    c = challenge.resume(l, raw.challenge);
  }
  if (raw.completed[raw.day] < 20 && raw.completed[raw.day] > 0 && !c)
    return fresh;
  if (
    raw.endedDate != null &&
    (!validDate(raw.endedDate) || raw.completed[raw.day] !== 20)
  )
    return fresh;
  const result = {
    ...fresh,
    day: raw.day,
    completed: raw.completed.slice(),
    stamps: raw.stamps.slice(),
    challenge: c,
    muted: raw.muted,
    endedDate: raw.endedDate || null,
    scene: raw.completed[raw.day] === 20
      ? raw.endedDate != null ? "ended" : "goodnight"
      : "home",
  };
  return result;
}
function voiceKey(s) {
  if (s.scene === "home") return "welcome";
  if (s.scene === "goodnight")
    return s.completed.every((x) => x === 20) ? "finished" : "daycomplete";
  if (s.scene === "ended") return "goodnight";
  if (isComplete(s))
    return currentLevel(s).index === 19
      ? s.day === 2
        ? "finished"
        : "daycomplete"
      : "success";
  const l = currentLevel(s);
  return l.type === "care"
    ? ["pillow", "blanket", "lamp"][s.challenge.step]
    : l.voice;
}
module.exports = {
  initialState,
  currentLevel,
  availableDay,
  needsParent,
  progress,
  goal,
  isComplete,
  reduce,
  restore,
  voiceKey,
};

},
"src/levels.js":function(require,module,exports){
const DAY_THEMES = ["星光森林", "月亮海湾", "云朵星球"];
const TYPES = [
  "find",
  "bridge",
  "count",
  "sort",
  "memory",
  "sequence",
  "order",
  "find",
  "bridge",
  "count",
  "sort",
  "memory",
  "sequence",
  "order",
  "find",
  "count",
  "sort",
  "memory",
  "sequence",
  "care",
];
const SHAPES = ["star", "circle", "triangle", "square", "moon", "heart"];
const COLORS = ["blue", "coral", "yellow", "green"];
const CATEGORY = {
  fruit: ["apple", "pear", "banana"],
  toy: ["ball", "block", "car"],
  clothes: ["shirt", "sock", "hat"],
};
const LABELS = {
  find: "找一找",
  bridge: "拼好小桥",
  count: "数一数",
  sort: "整理小物件",
  memory: "翻牌找朋友",
  sequence: "点亮彩色灯",
  order: "从小排到大",
  care: "伙伴晚安",
};
function shuffled(values, seed) {
  const a = values.slice();
  let n = seed * 7919 + 17;
  for (let i = a.length - 1; i > 0; i--) {
    n = (n * 16807) % 2147483647;
    const j = n % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const LEVELS = [];
for (let day = 0; day < 3; day++) {
  const seen = {};
  TYPES.forEach((type, index) => {
    const occurrence = seen[type] || 0;
    seen[type] = occurrence + 1;
    const id = day * 20 + index + 1,
      level = {
        id,
        day,
        index,
        type,
        title: LABELS[type],
        theme: DAY_THEMES[day],
        voice: type,
      };
    const shift = day * 2 + occurrence;
    if (type === "find") {
      level.target = SHAPES[(occurrence * 2 + day) % 6];
      const distractors = SHAPES.filter((s) => s !== level.target);
      level.items = shuffled(
        [
          ...Array(3 + day).fill(level.target),
          ...Array.from(
            { length: day + 1 },
            (_, i) => distractors[(i + shift) % distractors.length],
          ),
        ],
        id,
      );
    }
    if (type === "bridge") {
      level.targets = Array.from(
        { length: 3 + day },
        (_, i) => SHAPES[(i + shift) % 6],
      );
      level.items = shuffled(level.targets, id + 4);
    }
    if (type === "count") {
      level.count = 1 + day + occurrence;
      level.icon = SHAPES[(day + occurrence * 2) % 6];
      const candidates = [1, 2, 3, 4, 5, 6].filter((n) => n !== level.count);
      level.choices = shuffled(
        [level.count, ...shuffled(candidates, id).slice(0, 2)],
        id + 20,
      );
    }
    if (type === "sort") {
      level.categories =
        day === 0
          ? occurrence % 2
            ? ["fruit", "clothes"]
            : ["fruit", "toy"]
          : day === 1 && occurrence === 0
            ? ["toy", "clothes"]
            : ["fruit", "toy", "clothes"];
      level.items = shuffled(
        Array.from({ length: 4 + day }, (_, i) => {
          const category = level.categories[i % level.categories.length];
          return {
            category,
            icon: CATEGORY[category][
              (Math.floor(i / level.categories.length) + occurrence + day) % 3
            ],
          };
        }),
        id,
      );
    }
    if (type === "memory") {
      const pairs = day === 0 ? 2 : day === 1 ? 3 : occurrence === 0 ? 3 : 4;
      const symbols = Array.from(
        { length: pairs },
        (_, i) => SHAPES[(i + shift) % 6],
      );
      level.cards = shuffled([...symbols, ...symbols], id);
    }
    if (type === "sequence") {
      const sequences = [
        [
          [0, 1],
          [2, 0],
          [3, 1],
        ],
        [
          [0, 3, 2],
          [1, 0, 3],
          [2, 1, 0],
        ],
        [
          [3, 0, 1],
          [0, 2, 3, 1],
          [1, 3, 2, 0],
        ],
      ];
      level.colors = COLORS;
      level.sequence = sequences[day][occurrence].map((i) => COLORS[i]);
    }
    if (type === "order") {
      level.icon = SHAPES[(day + occurrence * 3) % 6];
      level.sizes = shuffled(day === 2 ? [24, 34, 44, 54] : [28, 42, 56], id);
    }
    if (type === "care") {
      level.animal = ["rabbit", "bear", "dino"][day];
      level.voice = "pillow";
    }
    LEVELS.push(level);
  });
}
module.exports = { LEVELS, DAY_THEMES, SHAPES, COLORS, CATEGORY, shuffled };

},
"src/challenges.js":function(require,module,exports){
function initial(l) {
  if (l.type === "find") return { found: [] };
  if (l.type === "bridge" || l.type === "sort") return { placed: [] };
  if (l.type === "count") return { solved: false };
  if (l.type === "memory") return { matched: [], open: [] };
  if (l.type === "sequence") return { step: 0, mode: "demo" };
  if (l.type === "order") return { picked: [] };
  return { step: 0 };
}
function goal(l) {
  if (l.type === "find") return l.items.filter((x) => x === l.target).length;
  if (["bridge", "sort"].includes(l.type)) return l.items.length;
  if (l.type === "memory") return l.cards.length / 2;
  if (l.type === "sequence") return l.sequence.length;
  if (l.type === "order") return l.sizes.length;
  if (l.type === "care") return 3;
  return 1;
}
function progress(l, c) {
  if (!c) return 0;
  if (l.type === "find") return c.found.length;
  if (["bridge", "sort"].includes(l.type)) return c.placed.length;
  if (l.type === "memory") return c.matched.length / 2;
  if (l.type === "sequence" || l.type === "care") return c.step;
  if (l.type === "order") return c.picked.length;
  return c.solved ? 1 : 0;
}
function complete(l, c) {
  return progress(l, c) === goal(l);
}
function update(l, c, a) {
  if (complete(l, c)) return c;
  const index = a.index,
    hasIndex = Number.isInteger(index) && index >= 0;
  if (
    l.type === "find" &&
    a.type === "pick" &&
    hasIndex &&
    l.items[index] === l.target &&
    !c.found.includes(index)
  )
    return { ...c, found: [...c.found, index] };
  if (
    ["bridge", "sort"].includes(l.type) &&
    a.type === "place" &&
    hasIndex &&
    l.items[index] &&
    !c.placed.includes(index)
  ) {
    const target =
      l.type === "bridge" ? l.items[index] : l.items[index].category;
    if (target === a.target) return { ...c, placed: [...c.placed, index] };
  }
  if (l.type === "count" && a.type === "answer" && a.value === l.count)
    return { solved: true };
  if (l.type === "memory") {
    if (a.type === "close") return c.open.length ? { ...c, open: [] } : c;
    if (
      a.type === "flip" &&
      hasIndex &&
      index < l.cards.length &&
      !c.matched.includes(index) &&
      !c.open.includes(index) &&
      c.open.length < 2
    ) {
      const open = [...c.open, index];
      if (open.length === 2 && l.cards[open[0]] === l.cards[open[1]])
        return { matched: [...c.matched, ...open], open: [] };
      return { ...c, open };
    }
  }
  if (l.type === "sequence") {
    if (a.type === "replay") return { step: 0, mode: "demo" };
    if (a.type === "demoDone" && c.mode === "demo")
      return { ...c, mode: "input" };
    if (a.type === "color" && c.mode === "input")
      return l.sequence[c.step] === a.value
        ? { ...c, step: c.step + 1 }
        : { step: 0, mode: "demo" };
  }
  if (
    l.type === "order" &&
    a.type === "pick" &&
    hasIndex &&
    !c.picked.includes(index)
  ) {
    const next = [...l.sizes].sort((x, y) => x - y)[c.picked.length];
    if (l.sizes[index] === next) return { picked: [...c.picked, index] };
  }
  if (
    l.type === "care" &&
    a.type === "care" &&
    ["pillow", "blanket", "lamp"][c.step] === a.item
  )
    return { step: c.step + 1 };
  return c;
}
function valid(l, c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const list = (a, max) =>
    Array.isArray(a) &&
    new Set(a).size === a.length &&
    a.every((i) => Number.isInteger(i) && i >= 0 && i < max);
  if (l.type === "find")
    return (
      list(c.found, l.items.length) &&
      c.found.every((i) => l.items[i] === l.target)
    );
  if (["bridge", "sort"].includes(l.type))
    return list(c.placed, l.items.length);
  if (l.type === "count") return typeof c.solved === "boolean";
  if (l.type === "memory")
    return (
      list(c.matched, l.cards.length) &&
      c.matched.length % 2 === 0 &&
      c.matched.every(
        (i) => c.matched.filter((j) => l.cards[i] === l.cards[j]).length === 2,
      ) &&
      list(c.open, l.cards.length) &&
      c.open.length <= 2 &&
      c.open.every((i) => !c.matched.includes(i))
    );
  if (l.type === "sequence")
    return (
      Number.isInteger(c.step) &&
      c.step >= 0 &&
      c.step <= l.sequence.length &&
      ["demo", "input"].includes(c.mode) &&
      (c.mode !== "demo" || c.step === 0)
    );
  if (l.type === "order")
    return (
      list(c.picked, l.sizes.length) &&
      c.picked.every(
        (v, i) => l.sizes[v] === [...l.sizes].sort((a, b) => a - b)[i],
      )
    );
  return Number.isInteger(c.step) && c.step >= 0 && c.step <= 3;
}
function resume(l, c) {
  if (!valid(l, c)) return initial(l);
  const copy = JSON.parse(JSON.stringify(c));
  if (l.type === "memory") copy.open = [];
  if (l.type === "sequence" && !complete(l, copy)) return initial(l);
  return copy;
}
function instruction(l, c) {
  if (complete(l, c))
    return l.type === "care"
      ? "伙伴睡着啦，本组的冒险完成了！"
      : "完成啦！一起去下一关吧。";
  const texts = {
    find: "找到和上面图案一样的所有图形吧！",
    bridge: "把桥板放到相同图案的位置吧！",
    count: "数一数，选出一样多的圆点吧！",
    sort: "把物件送回同一类的篮子吧！",
    memory: "翻开卡片，找到相同的两个图案吧！",
    sequence:
      c.mode === "demo"
        ? "看清彩灯亮起的顺序，再照着点一遍。"
        : "轮到你啦，按刚才的顺序点彩灯吧！",
    order: "找一找，从最小的开始依次点一下吧！",
  };
  return l.type === "care"
    ? [
        "先把枕头放到伙伴头下吧！",
        "再给伙伴盖上柔软的小被子吧！",
        "最后，轻轻关掉小灯吧！",
      ][c.step]
    : texts[l.type];
}
module.exports = {
  initial,
  goal,
  progress,
  complete,
  update,
  valid,
  resume,
  instruction,
};

},
"src/calendar.js":function(require,module,exports){
function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function validDate(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    y >= 2000 &&
    y <= 9999 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}
module.exports = { localDate, validDate };

},
"src/layout.js":function(require,module,exports){
const WIDTH = 1280;
const HEIGHT = 720;
const UI = {
  back: { x: 26, y: 24, w: 82, h: 62 },
  start: { x: 645, y: 515, w: 410, h: 82 },
  end: { x: 490, y: 608, w: 300, h: 80 },
  parent: { x: 18, y: 672, w: 190, h: 40 },
  parentNext: { x: 900, y: 672, w: 350, h: 40 },
  mute: { x: 1100, y: 100, w: 146, h: 48 },
  speaker: { x: 1107, y: 623, w: 76, h: 66 },
  next: { x: 865, y: 619, w: 300, h: 76 },
  retry: { x: 490, y: 410, w: 300, h: 76 },
};
const DAYS = Array.from({ length: 3 }, (_, i) => ({
  x: 400 + i * 276,
  y: 255,
  w: 254,
  h: 220,
  day: i,
}));
function viewportTransform(viewport) {
  const { width, height } = viewport;
  const s = viewport.safeArea || {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
  };
  const left = Math.max(0, s.left || 0),
    top = Math.max(0, s.top || 0);
  const right = Math.min(width, s.right == null ? width : s.right);
  const bottom = Math.min(height, s.bottom == null ? height : s.bottom);
  const scale = Math.max(
    0.01,
    Math.min((right - left) / WIDTH, (bottom - top) / HEIGHT),
  );
  return {
    x: left + (right - left - WIDTH * scale) / 2,
    y: top + (bottom - top - HEIGHT * scale) / 2,
    scale,
    width,
    height,
    dpr: Math.min(3, Math.max(1, viewport.dpr || 1)),
  };
}

function toLogical(v, x, y) {
  const point = { x: (x - v.x) / v.scale, y: (y - v.y) / v.scale };
  return point.x >= 0 && point.y >= 0 && point.x <= WIDTH && point.y <= HEIGHT
    ? point
    : null;
}
function contains(rect, point, padding = 0) {
  return (
    !!point &&
    point.x >= rect.x - padding &&
    point.y >= rect.y - padding &&
    point.x <= rect.x + rect.w + padding &&
    point.y <= rect.y + rect.h + padding
  );
}
function inCircle(circle, point, padding = 0) {
  return (
    !!point &&
    Math.hypot(point.x - circle.x, point.y - circle.y) <= circle.r + padding
  );
}
module.exports = {
  DAYS,
  WIDTH,
  HEIGHT,
  UI,
  viewportTransform,
  toLogical,
  contains,
  inCircle,
};

},
"src/challenge-layout.js":function(require,module,exports){
function row(count, y, w = 740, h = 105, x = 430) {
  const gap = 18,
    cell = (w - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({
    x: x + i * (cell + gap),
    y,
    w: cell,
    h,
    index: i,
  }));
}
function grid(
  count,
  {
    x = 410,
    y = 230,
    w = 790,
    h = 335,
    columns = Math.min(4, count),
    gap = 20,
  } = {},
) {
  const rows = Math.ceil(count / columns),
    cw = (w - gap * (columns - 1)) / columns,
    ch = (h - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: x + (i % columns) * (cw + gap),
    y: y + Math.floor(i / columns) * (ch + gap),
    w: cw,
    h: ch,
    index: i,
  }));
}
function layoutFor(l) {
  const out = {
    items: [],
    targets: [],
    help: { x: 445, y: 145, w: 180, h: 54 },
  };
  if (l.type === "find") out.items = grid(l.items.length, { y: 230, h: 340 });
  if (l.type === "bridge") {
    out.items = row(l.items.length, 485, 780, 100, 420);
    out.targets = row(l.targets.length, 300, 780, 120, 420).map((r, i) => ({
      ...r,
      value: l.targets[i],
    }));
  }
  if (l.type === "count") {
    out.objects = row(l.count, 250, 730, 105, 445);
    out.items = row(3, 450, 730, 115, 445).map((r, i) => ({
      ...r,
      value: l.choices[i],
    }));
  }
  if (l.type === "sort") {
    out.items = grid(l.items.length, {
      x: 420,
      y: 225,
      w: 780,
      h: 190,
      columns: 3,
      gap: 16,
    });
    out.targets = row(l.categories.length, 470, 780, 110, 420).map((r, i) => ({
      ...r,
      value: l.categories[i],
    }));
  }
  if (l.type === "memory")
    out.items = grid(l.cards.length, {
      y: 235,
      h: 345,
      columns: l.cards.length === 4 ? 2 : 4,
      gap: 18,
    });
  if (l.type === "sequence")
    out.items = row(4, 340, 780, 145, 420).map((r, i) => ({
      ...r,
      value: l.colors[i],
    }));
  if (l.type === "order") out.items = row(l.sizes.length, 350, 780, 170, 420);
  if (l.type === "care") {
    out.items = [
      { x: 450, y: 520, w: 190, h: 82, index: 0, value: "pillow" },
      { x: 750, y: 520, w: 210, h: 82, index: 1, value: "blanket" },
      { x: 1100, y: 260, w: 140, h: 240, index: 2, value: "lamp" },
    ];
    out.targets = [
      { x: 900, y: 330, w: 145, h: 105, value: "pillow" },
      { x: 575, y: 330, w: 335, h: 165, value: "blanket" },
    ];
  }
  return out;
}
module.exports = { layoutFor, row, grid };

},
"src/draw.js":function(require,module,exports){
const { UI, DAYS } = require("./layout");
const model = require("./model");
const challenge = require("./challenges");
const { DAY_THEMES } = require("./levels");
const { drawChallenge } = require("./challenge-draw");
const p = require("./paint");
const fx = require("./feedback-draw");
const {characterRect}=require('./character-motion');
const PALETTES = [
  ["#bec7f7", "#c3e8cf"],
  ["#bcd9ed", "#c7e4e3"],
  ["#d0c7ef", "#dde5f5"],
];
function outdoor(ctx, day = 0) {
  ctx.save();
  const [sky, ground] = PALETTES[day];
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1280, 720);
  p.moon(ctx, 1118, 195, 28, sky);
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.moveTo(0, 390);
  ctx.quadraticCurveTo(680, 285, 1280, 340);
  ctx.lineTo(1280, 720);
  ctx.lineTo(0, 720);
  ctx.fill();
  ctx.strokeStyle = "#fff2da";
  ctx.lineWidth = 65;
  ctx.beginPath();
  ctx.moveTo(100, 710);
  ctx.bezierCurveTo(130, 560, 1120, 520, 1100, 300);
  ctx.stroke();
  [
    [35, 360],
    [1245, 310],
  ].forEach(([x, y]) => {
    p.round(ctx, x - 6, y, 12, 73, 5, "#c6a487");
    p.oval(ctx, x, y, 34, 42, "#9fd4ae");
  });
  ctx.restore();
}
function room(ctx, darkness = 0) {
  ctx.fillStyle = fx.tint("#c8c5f5", "#7e87bd", darkness);
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = fx.tint("#f7e5da", "#9da8ca", darkness);
  ctx.fillRect(0, 440, 1280, 280);
  p.round(ctx, 440, 150, 170, 120, 29, "#f5dcc9");
  p.round(ctx, 450, 160, 150, 100, 23, "#41649c");
  p.moon(ctx, 548, 194, 22, "#41649c");
}
function parent(ctx, s, ui) {
  p.text(ctx, "家长：长按重新开始", 110, 693, 16, "#576b92", "center", 400);
  if (model.needsParent(s) && ["home", "goodnight", "ended"].includes(s.scene))
    p.text(
      ctx,
      `家长：长按开启第 ${model.availableDay(s) + 1} 组`,
      1075,
      693,
      17,
      "#576b92",
    );
  if (ui.parentHold > 0) {
    const next = ui.parentAction === "parentContinue";
    p.round(
      ctx,
      next ? 900 : 22,
      712,
      (next ? 350 : 177) * ui.parentHold,
      4,
      2,
      "#f3cb65",
    );
  }
}
function soundLabel(s,ui){
  if(s.muted)return '声音：关';
  const status=ui.audio&&ui.audio.status;
  if(status==='error')return '重试声音';
  if(status==='locked'||status==='blocked')return '点此开声';
  if(status==='loading'||status==='unlocking')return '声音准备中';
  return '声音：开';
}
function render(ctx, s, ui) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  if (ui.loading || ui.error) {
    ctx.fillStyle = PALETTES[0][0];
    ctx.fillRect(0, 0, 1280, 720);
    p.text(
      ctx,
      ui.error ? "图片还没准备好" : "小铭和赛罗正在准备出发",
      640,
      325,
      35,
    );
    if (ui.error) p.button(ctx, UI.retry, "重试");
    return;
  }
  if (s.scene === "home") {
    outdoor(ctx, Math.max(0, model.availableDay(s, ui.today)));
    fx.drawDuo(ctx, ui.images.adventure, characterRect(s.scene), ui);
    p.text(ctx, "小铭和赛罗的晚安冒险", 800, 87, 43);
    p.text(ctx, "三组小冒险 · 每组20关", 800, 145, 26);
    const open = model.availableDay(s, ui.today);
    DAYS.forEach((r, i) => {
      const done = s.completed[i] === 20,
        locked = !done && open !== i;
      p.round(ctx, r.x, r.y, r.w, r.h, 27, locked ? "#e0e5ee" : p.C.cream);
      p.text(ctx, `第 ${i + 1} 组`, r.x + r.w / 2, r.y + 42, 29);
      p.text(ctx, DAY_THEMES[i], r.x + r.w / 2, r.y + 86, 25);
      p.text(ctx, `${s.completed[i]} / 20 关`, r.x + r.w / 2, r.y + 132, 25);
      p.text(
        ctx,
        done
          ? "✓ 已打卡"
          : locked
            ? "完成前一组开放"
            : model.needsParent(s)
              ? "家长可开启"
              : "可以出发",
        r.x + r.w / 2,
        r.y + 177,
        23,
        done ? "#639875" : "#6b7d9f",
      );
      if (done)
        p.text(ctx, s.stamps[i], r.x + r.w / 2, r.y + 207, 15, "#7888a1");
    });
    if (open >= 0)
      p.button(
        ctx,
        UI.start,
        model.needsParent(s)
          ? `家长长按开启第 ${open + 1} 组`
          : !s.muted && ui.audio && ['locked','blocked'].includes(ui.audio.status)
            ? '开启声音并出发'
          : s.completed[open] > 0
            ? "继续本组冒险"
            : `开始第 ${open + 1} 组`,
        29,
      );
    else
      p.text(
        ctx,
        s.completed.every((n) => n === 20)
          ? "三组全部打卡，真棒！"
          : "先完成前一组冒险吧",
        815,
        553,
        28,
      );
    p.text(
      ctx,
      ui.message ||
        (s.notice
          ? "新冒险已准备好，从第一组开始吧"
          : "点点角色，他们会打招呼；进度会保存"),
      815,
      622,
      22,
      "#6276a4",
    );
    p.button(ctx, UI.mute, soundLabel(s,ui), 21);
    parent(ctx, s, ui);
    fx.drawOverlay(ctx, ui, s.scene);
    return;
  }
  if (s.scene === "goodnight" || s.scene === "ended") {
    ctx.fillStyle = "#b8baf0";
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "#c7d1f5";
    ctx.fillRect(0, 548, 1280, 172);
    p.round(ctx, 1055, 74, 155, 165, 35, "#f6e3d7");
    p.round(ctx, 1067, 86, 131, 141, 27, "#41629a");
    p.moon(ctx, 1154, 127, 27, "#41629a");
    p.text(ctx, "晚安，小铭", 640, 86, 59, p.C.cream);
    p.text(
      ctx,
      s.completed.every((n) => n === 20)
        ? "三组60关全部完成啦！"
        : `第 ${s.day + 1} 组 · 20关打卡完成`,
      640,
      154,
      31,
    );
    fx.drawDuo(ctx, ui.images.bedtime, characterRect(s.scene), ui, 'bedtime');
    if (s.scene === "goodnight") p.button(ctx, UI.end, "结束", 37);
    else
      p.text(
        ctx,
        s.completed.every((n) => n === 20)
          ? "谢谢你和赛罗一起冒险"
          : "这次冒险完成啦，好好休息吧",
        640,
        643,
        29,
      );
    parent(ctx, s, ui);
    fx.drawOverlay(ctx, ui, s.scene);
    return;
  }
  const l = model.currentLevel(s),
    c = s.challenge,
    done = model.isComplete(s);
  if (l.type === "care") {
    const sleep = fx.latest(ui, "sleep");
    room(ctx, c.step === 3 ? (sleep ? fx.ease(sleep.progress) : 1) : 0);
  } else outdoor(ctx, l.day);
  fx.drawDuo(ctx, ui.images.adventure, characterRect(s.scene), ui);
  drawChallenge(ctx, l, c, ui.layout, ui);
  p.button(ctx, UI.back, "‹", 57);
  p.text(ctx, l.title, 640, 55, 40);
  p.text(
    ctx,
    `第 ${l.day + 1} 组 · ${l.theme} · ${l.index + 1}/20关`,
    640,
    108,
    20,
    "#63769e",
  );
  p.round(ctx, 1110, 26, 144, 61, 28, p.C.cream);
  p.text(ctx, `${model.progress(s)} / ${model.goal(s)}`, 1182, 57, 32);
  p.button(ctx, UI.mute, soundLabel(s,ui), 21);
  if (done) {
    p.round(ctx, 274, 621, 574, 74, 30, p.C.cream);
    p.text(
      ctx,
      l.index === 19 ? "本组20关完成，打卡成功！" : "完成啦，继续下一关吧！",
      560,
      658,
      25,
    );
    p.button(ctx, UI.next, l.index === 19 ? "和赛罗说晚安" : "继续", 28);
  } else {
    p.round(ctx, 274, 621, 916, 74, 31, p.C.cream);
    p.text(ctx, ui.message || challenge.instruction(l, c), 698, 659, 25);
    p.speaker(ctx, 1144, 656, s.muted);
  }
  parent(ctx, s, ui);
  fx.drawOverlay(ctx, ui, s.scene);
}
module.exports = { render };

},
"src/challenge-draw.js":function(require,module,exports){
const p = require("./paint");
const { icon, animal, dots, COLORS } = require("./icons");
const ch = require("./challenges");
const fx = require("./feedback-draw");
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const CATEGORY_NAMES = { fruit: "水果", toy: "玩具", clothes: "衣物" };
const CATEGORY_ICON = { fruit: "apple", toy: "ball", clothes: "shirt" };
function card(ctx, r, selected = false) {
  if (selected) {
    ctx.save();
    ctx.shadowColor = "#ffda71";
    ctx.shadowBlur = 18;
  }
  p.round(ctx, r.x, r.y + 4, r.w, r.h, 22, "#c1b9d4");
  p.round(ctx, r.x, r.y, r.w, r.h, 22, selected ? "#ffedbd" : "#fff4db");
  if (selected) ctx.restore();
}
function source(ctx, l, r, selected, ui) {
  fx.withItem(ctx, ui, r.index, r, () => {
    card(ctx, r, selected);
    const c = center(r);
    icon(
      ctx,
      l.type === "bridge" ? l.items[r.index] : l.items[r.index].icon,
      c.x,
      c.y,
      Math.min(r.h * 0.68, 70),
    );
  });
}
function care(ctx, l, c, layout, ui) {
  p.round(ctx, 420, 325, 650, 180, 26, "#deb48f");
  p.round(ctx, 435, 326, 625, 130, 24, "#fff5e2");
  p.round(ctx, 420, 315, 28, 210, 14, "#e9c19b");
  p.round(ctx, 1038, 277, 36, 248, 18, "#e9c19b");
  if (c.step >= 1 && !fx.moving(ui, 0)) p.pillow(ctx, layout.targets[0]);
  else {
    ctx.save();
    ctx.setLineDash([8, 8]);
    p.round(ctx, 900, 330, 145, 105, 24, null, "#c5a18c");
    ctx.restore();
  }
  ctx.save();
  ctx.translate(930, 354);
  ctx.rotate(Math.PI / 2);
  const breath = c.step >= 2 ? Math.sin(ui.time / 1700) * 0.012 : 0;
  animal(ctx, l.animal, 0, 0, 1.04 + breath, c.step >= 2);
  ctx.restore();
  if (c.step >= 2 && !fx.moving(ui, 1)) p.blanket(ctx, layout.targets[1]);
  if (c.step >= 2) {
    ctx.save();
    for (let i = 0; i < 2; i++) {
      const t = (ui.time / 2300 + i * 0.5) % 1;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.5;
      p.text(ctx, "Z", 1000 + t * 22, 280 - t * 38, 15 + t * 7, "#667aad");
    }
    ctx.restore();
  }
  p.round(ctx, 1100, 408, 135, 91, 17, "#e9bd95");
  p.round(ctx, 1112, 425, 110, 43, 12, "#f7d5b0");
  p.round(ctx, 1157, 352, 24, 56, 10, "#d8a574");
  ctx.save();
  const sleep = fx.latest(ui, "sleep"),
    dark = c.step === 3 ? (sleep ? fx.ease(sleep.progress) : 1) : 0;
  if (dark < 1) {
    ctx.shadowColor = "#ffe2a7";
    ctx.shadowBlur = 22 * (1 - dark);
  }
  p.round(ctx, 1120, 286, 96, 80, 36, fx.tint("#fff3c2", "#9d9db9", dark));
  ctx.restore();
  if (c.step === 2) {
    ctx.save();
    ctx.lineWidth = 4;
    p.round(ctx, 1110, 275, 116, 104, 40, null, "#e8c668");
    ctx.restore();
  }
  layout.items.slice(0, 2).forEach((r, i) => {
    if (
      c.step <= i &&
      !fx.moving(ui, i) &&
      !(ui.drag && ui.drag.index === i && ui.drag.moved)
    )
      fx.withItem(ctx, ui, i, r, () =>
        p[i === 0 ? "pillow" : "blanket"](
          ctx,
          r,
          ui.selected === i || c.step === i,
        ),
      );
  });
  if (ui.drag && ui.drag.moved && ui.drag.index < 2) {
    const r = layout.items[ui.drag.index];
    p[r.value](
      ctx,
      { ...r, x: ui.drag.x - r.w / 2, y: ui.drag.y - r.h / 2 },
      true,
    );
  }
}
function drawChallenge(ctx, l, c, layout, ui) {
  if (l.type === "find") {
    p.text(ctx, "找这些", 518, 173, 23);
    icon(ctx, l.target, 600, 173, 52);
    p.text(ctx, `× ${ch.goal(l)}`, 663, 173, 26);
    layout.items.forEach((r) => {
      if (fx.moving(ui, r.index)) return;
      fx.withItem(ctx, ui, r.index, r, () => {
        const a = center(r);
        if (c.found.includes(r.index)) {
          p.oval(ctx, a.x, a.y, 26, 26, "#e8f2dc");
          p.text(ctx, "✓", a.x, a.y, 31, "#669b78");
        } else
          icon(
            ctx,
            l.items[r.index],
            a.x,
            a.y + Math.sin(ui.time / 1600 + r.index) * 2,
            Math.min(84, r.h * 0.68),
          );
      });
    });
  } else if (l.type === "bridge" || l.type === "sort") {
    if (l.type === "bridge") {
      p.round(ctx, 410, 287, 800, 12, 5, "#d3af89");
      p.round(ctx, 410, 423, 800, 12, 5, "#d3af89");
    }
    layout.targets.forEach((r) => {
      fx.withTarget(ctx, ui, r.value, r, () => {
        const a = center(r);
        ctx.save();
        ctx.setLineDash(l.type === "bridge" ? [8, 7] : []);
        p.round(ctx, r.x, r.y, r.w, r.h, 22, "#fef2db", "#b7a58f");
        ctx.restore();
        if (l.type === "bridge") {
          const placed = l.items.findIndex((x) => x === r.value);
          icon(ctx, r.value, a.x, a.y, 58);
          if (c.placed.includes(placed) && !fx.moving(ui, placed))
            p.text(ctx, "✓", r.x + r.w - 18, r.y + 18, 23, "#65a37e");
        } else {
          icon(ctx, CATEGORY_ICON[r.value], a.x, a.y - 12, 49);
          p.text(ctx, CATEGORY_NAMES[r.value], a.x, r.y + r.h - 22, 21);
        }
      });
    });
    layout.items.forEach((r) => {
      if (
        !c.placed.includes(r.index) &&
        !fx.moving(ui, r.index) &&
        !(ui.drag && ui.drag.index === r.index && ui.drag.moved)
      )
        source(ctx, l, r, ui.selected === r.index, ui);
    });
    if (ui.drag && ui.drag.moved) {
      const r = layout.items[ui.drag.index];
      source(
        ctx,
        l,
        { ...r, x: ui.drag.x - r.w / 2, y: ui.drag.y - r.h / 2 },
        true,
        ui,
      );
    }
  } else if (l.type === "count") {
    layout.objects.forEach((r) => {
      const a = center(r);
      icon(ctx, l.icon, a.x, a.y, 78);
    });
    layout.items.forEach((r) => {
      fx.withItem(ctx, ui, r.index, r, () => {
        card(ctx, r, c.solved && r.value === l.count);
        const a = center(r);
        dots(ctx, r.value, a.x, a.y, 14);
      });
    });
  } else if (l.type === "memory") {
    p.button(ctx, layout.help, "看一眼", 23);
    layout.items.forEach((r) => {
      const a = center(r),
        matched = c.matched.includes(r.index),
        flip = fx.latest(ui, "flip", r.index);
      let shown = matched || c.open.includes(r.index) || ui.peek;
      if (flip && !ui.peek)
        shown = flip.progress < 0.5 ? flip.fromShown : flip.toShown;
      ctx.save();
      if (flip) {
        ctx.translate(a.x, a.y);
        ctx.scale(
          Math.max(0.04, Math.abs(Math.cos(flip.progress * Math.PI))),
          1,
        );
        ctx.translate(-a.x, -a.y);
      }
      p.round(
        ctx,
        r.x,
        r.y,
        r.w,
        r.h,
        22,
        shown ? (matched ? "#d9edcf" : "#fff3dc") : "#93a9db",
      );
      if (shown) icon(ctx, l.cards[r.index], a.x, a.y, Math.min(76, r.h * 0.6));
      else {
        p.text(ctx, "?", a.x, a.y, 49, "#f9f1d9");
      }
      ctx.restore();
    });
  } else if (l.type === "sequence") {
    p.button(ctx, layout.help, "再看一次", 23);
    p.text(ctx, c.mode === "demo" ? "先看示范" : "轮到你啦", 817, 250, 28);
    layout.items.forEach((r, i) => {
      fx.withItem(ctx, ui, r.index, r, () => {
        const a = center(r),
          lit = ui.activeColor === r.value;
        ctx.save();
        if (lit) {
          ctx.translate(a.x, a.y);
          ctx.scale(1.035, 1.035);
          ctx.translate(-a.x, -a.y);
          ctx.shadowColor = "#fff0a9";
          ctx.shadowBlur = 28;
        }
        // 亮起时仍保留灯的颜色，以免演示时丢失配对线索。
        p.round(ctx, r.x, r.y, r.w, r.h, 31, COLORS[r.value]);
        ctx.shadowBlur = 0;
        p.round(ctx, a.x - 43, a.y - 43, 86, 86, 22, "#fff5df");
        icon(ctx, ["circle", "triangle", "star", "square"][i], a.x, a.y, 61);
        if (lit) {
          ctx.lineWidth = 5;
          p.round(ctx, r.x, r.y, r.w, r.h, 31, null, "#fffaf0");
        }
        ctx.restore();
      });
    });
    for (let i = 0; i < l.sequence.length; i++)
      p.oval(
        ctx,
        745 + i * 45,
        548,
        11,
        11,
        i < c.step ? "#f6d56c" : "#e0e6f5",
      );
  } else if (l.type === "order") {
    p.text(ctx, "小  →  大", 810, 245, 30);
    layout.items.forEach((r) => {
      if (fx.moving(ui, r.index)) return;
      fx.withItem(ctx, ui, r.index, r, () => {
        const a = center(r);
        if (c.picked.includes(r.index)) {
          p.oval(ctx, a.x, a.y, 25, 25, "#e8f2dc");
          p.text(ctx, "✓", a.x, a.y, 31, "#669b78");
        } else icon(ctx, l.icon, a.x, a.y, l.sizes[r.index] * 2);
      });
    });
  } else care(ctx, l, c, layout, ui);
}
module.exports = { drawChallenge };

},
"src/paint.js":function(require,module,exports){
const C = { ink: '#31528e', cream: '#fff5dd', blue: '#7db9f6', gold: '#ffd560', coral: '#ffb39e', mint: '#c3e8cf', line: '#caa98b' };
function round(ctx, x, y, w, h, r, fill, stroke) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}
function oval(ctx, x, y, rx, ry, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry); ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.restore();
}
function text(ctx, value, x, y, size = 28, color = C.ink, align = 'center', weight = 600) {
  ctx.fillStyle = color; ctx.font = `${weight} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(value, x, y);
}
function moon(ctx, x, y, r, background) {
  oval(ctx, x, y, r, r, C.cream); oval(ctx, x - r * 0.37, y - r * 0.3, r * 0.93, r * 0.93, background);
}
function star(ctx, x, y, r, color = C.gold, glow = false) {
  ctx.save(); if (glow) { ctx.shadowColor = '#ffdc79'; ctx.shadowBlur = 22; }
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? r * 0.5 : r; const px = x + Math.cos(a) * radius, py = y + Math.sin(a) * radius; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#f2b94d'; ctx.stroke(); ctx.restore();
}
function button(ctx, rect, label, size = 29, active = false) {
  round(ctx, rect.x, rect.y + 5, rect.w, rect.h, 26, '#c1bedf');
  round(ctx, rect.x, rect.y, rect.w, rect.h, 26, active ? '#ffe6a6' : C.cream);
  text(ctx, label, rect.x + rect.w / 2, rect.y + rect.h / 2, size);
}
function speaker(ctx, x, y, muted) {
  ctx.save(); ctx.strokeStyle = C.ink; ctx.fillStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - 17, y - 8); ctx.lineTo(x - 7, y - 8); ctx.lineTo(x + 5, y - 20); ctx.lineTo(x + 5, y + 20); ctx.lineTo(x - 7, y + 8); ctx.lineTo(x - 17, y + 8); ctx.closePath(); ctx.fill();
  if (muted) { ctx.beginPath(); ctx.moveTo(x + 13, y - 9); ctx.lineTo(x + 28, y + 9); ctx.moveTo(x + 28, y - 9); ctx.lineTo(x + 13, y + 9); ctx.stroke(); }
  else { [16, 26].forEach(r => { ctx.beginPath(); ctx.arc(x + 1, y, r, -0.75, 0.75); ctx.stroke(); }); }
  ctx.restore();
}
function shape(ctx, kind, x, y, size, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha;
  if (kind === 'circle') oval(ctx, x, y, size * 0.48, size * 0.48, '#70b4fa');
  if (kind === 'square') round(ctx, x - size * 0.45, y - size * 0.45, size * 0.9, size * 0.9, 13, '#ffd15a');
  if (kind === 'triangle') { ctx.fillStyle = '#ffa68f'; ctx.beginPath(); ctx.moveTo(x, y - size * 0.53); ctx.lineTo(x + size * 0.52, y + size * 0.43); ctx.lineTo(x - size * 0.52, y + size * 0.43); ctx.closePath(); ctx.fill(); }
  ctx.restore();
}
function duo(ctx, image, rect) {
  if (!image || !image.width || !image.height) return;
  const s = Math.min(rect.w / image.width, rect.h / image.height);
  const w = image.width * s, h = image.height * s;
  ctx.drawImage(image, rect.x + (rect.w - w) / 2, rect.y + rect.h - h, w, h);
}
function rabbit(ctx, x, y, scale = 1, sleeping = false) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  oval(ctx, 0, 40, 36, 44, '#95c7ee');
  oval(ctx, -16, -43, 12, 36, '#fffaf2'); oval(ctx, 17, -43, 12, 36, '#fffaf2');
  oval(ctx, -16, -45, 5, 24, '#f9c0cc'); oval(ctx, 17, -45, 5, 24, '#f9c0cc');
  oval(ctx, 0, 0, 43, 37, '#fffaf2');
  oval(ctx, -28, 10, 8, 5, '#f6b5b7'); oval(ctx, 28, 10, 8, 5, '#f6b5b7');
  if (sleeping) {
    ctx.strokeStyle = '#735c63'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-22, -2); ctx.quadraticCurveTo(-16, 4, -10, -2); ctx.moveTo(10, -2); ctx.quadraticCurveTo(16, 4, 22, -2); ctx.stroke();
  } else { oval(ctx, -16, -3, 3.5, 5, '#735c63'); oval(ctx, 16, -3, 3.5, 5, '#735c63'); }
  oval(ctx, 0, 7, 4, 3, '#d8929b'); ctx.strokeStyle = '#c28e97'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 12, 6, 0.2, Math.PI - 0.2); ctx.stroke();
  ctx.restore();
}
function pillow(ctx, rect, active = false) {
  ctx.save(); if (active) { ctx.shadowColor = '#ffd66e'; ctx.shadowBlur = 18; }
  round(ctx, rect.x, rect.y, rect.w, rect.h, 32, '#fffaec', '#e8d6bb'); ctx.restore();
  round(ctx, rect.x + 10, rect.y + 10, rect.w - 20, rect.h - 20, 26, null, '#f1e6d1');
}
function blanket(ctx, rect, active = false) {
  ctx.save(); if (active) { ctx.shadowColor = '#ffd66e'; ctx.shadowBlur = 18; }
  round(ctx, rect.x, rect.y, rect.w, rect.h, 25, '#98c7f2', '#73a9dd'); ctx.restore();
  round(ctx, rect.x + 7, rect.y + rect.h - 22, rect.w - 14, 16, 7, '#b1d8fa');
  moon(ctx, rect.x + rect.w * 0.55, rect.y + rect.h * 0.39, Math.min(25, rect.h * 0.26), '#98c7f2');
}
module.exports = { C, round, oval, text, moon, star, button, speaker, shape, duo, rabbit, pillow, blanket };

},
"src/icons.js":function(require,module,exports){
const p = require("./paint");
const COLORS = {
  blue: "#6aaaf3",
  coral: "#f7a38e",
  yellow: "#f4ce58",
  green: "#89c99e",
};
function icon(ctx, kind, x, y, size) {
  const r = size / 2;
  ctx.save();
  ctx.translate(x, y);
  if (kind === "star") p.star(ctx, 0, 0, r, "#ffd560");
  else if (["circle", "triangle", "square"].includes(kind))
    p.shape(ctx, kind, 0, 0, size);
  else if (kind === "moon") {
    ctx.fillStyle = "#8d99df";
    ctx.beginPath();
    ctx.moveTo(r * 0.6, -r * 0.85);
    ctx.bezierCurveTo(-r * 1.4, -r, -r * 1.4, r, r * 0.65, r * 0.8);
    ctx.bezierCurveTo(
      -r * 0.3,
      r * 0.45,
      -r * 0.3,
      -r * 0.5,
      r * 0.6,
      -r * 0.85,
    );
    ctx.fill();
  } else if (kind === "heart") {
    ctx.fillStyle = "#f5a4bd";
    ctx.beginPath();
    ctx.moveTo(0, r * 0.85);
    ctx.bezierCurveTo(-r * 1.6, -r * 0.2, -r * 0.7, -r * 1.5, 0, -r * 0.45);
    ctx.bezierCurveTo(r * 0.7, -r * 1.5, r * 1.6, -r * 0.2, 0, r * 0.85);
    ctx.fill();
  } else if (kind === "apple" || kind === "pear") {
    p.oval(
      ctx,
      0,
      r * 0.15,
      r * 0.75,
      r * (kind === "pear" ? 0.85 : 0.7),
      kind === "apple" ? "#f29b91" : "#b7cc79",
    );
    if (kind === "pear")
      p.oval(ctx, 0, -r * 0.35, r * 0.4, r * 0.55, "#b7cc79");
    p.round(ctx, -2, -r * 0.8, 5, r * 0.35, 2, "#967957");
    p.oval(ctx, r * 0.25, -r * 0.7, r * 0.3, r * 0.13, "#8ab788");
  } else if (kind === "banana") {
    ctx.strokeStyle = "#f5d369";
    ctx.lineWidth = r * 0.43;
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, -r * 0.6);
    ctx.quadraticCurveTo(-r * 0.4, r * 1.1, r * 0.8, r * 0.3);
    ctx.stroke();
  } else if (kind === "ball") {
    p.oval(ctx, 0, 0, r * 0.8, r * 0.8, "#91b9f0");
    ctx.strokeStyle = "#fff5dd";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, -r * 0.3);
    ctx.quadraticCurveTo(0, r * 0.1, r * 0.6, r * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.75);
    ctx.quadraticCurveTo(-r * 0.3, 0, r * 0.2, r * 0.75);
    ctx.stroke();
  } else if (kind === "block") {
    p.round(ctx, -r * 0.75, -r * 0.75, r * 1.5, r * 1.5, 10, "#f2c96b");
    p.shape(ctx, "triangle", 0, 0, r);
  } else if (kind === "car") {
    p.round(ctx, -r * 0.9, -r * 0.2, r * 1.8, r * 0.75, 8, "#eda38c");
    p.round(ctx, -r * 0.5, -r * 0.65, r, r * 0.7, 10, "#eda38c");
    p.round(ctx, -r * 0.35, -r * 0.5, r * 0.7, r * 0.4, 3, "#d4edfa");
    [-0.55, 0.55].forEach((a) =>
      p.oval(ctx, r * a, r * 0.6, r * 0.21, r * 0.21, "#7186a9"),
    );
  } else if (kind === "shirt") {
    ctx.fillStyle = "#a7baf1";
    ctx.beginPath();
    ctx.moveTo(-r * 0.35, -r * 0.7);
    ctx.lineTo(-r * 0.9, -r * 0.35);
    ctx.lineTo(-r * 0.55, r * 0.05);
    ctx.lineTo(-r * 0.42, -r * 0.05);
    ctx.lineTo(-r * 0.42, r * 0.8);
    ctx.lineTo(r * 0.42, r * 0.8);
    ctx.lineTo(r * 0.42, -r * 0.05);
    ctx.lineTo(r * 0.55, r * 0.05);
    ctx.lineTo(r * 0.9, -r * 0.35);
    ctx.lineTo(r * 0.35, -r * 0.7);
    ctx.quadraticCurveTo(0, -r * 0.3, -r * 0.35, -r * 0.7);
    ctx.fill();
  } else if (kind === "sock") {
    p.round(ctx, -r * 0.2, -r * 0.8, r * 0.55, r * 1.4, 8, "#e9adc7");
    p.round(ctx, -r * 0.65, r * 0.2, r * 0.95, r * 0.55, 10, "#e9adc7");
  } else if (kind === "hat") {
    p.oval(ctx, 0, r * 0.4, r * 0.9, r * 0.2, "#a8cba9");
    p.round(ctx, -r * 0.55, -r * 0.65, r * 1.1, r * 1.1, 20, "#a8cba9");
  }
  ctx.restore();
}
function animal(ctx, kind, x, y, scale = 1, sleeping = false) {
  if (kind === "rabbit") {
    p.rabbit(ctx, x, y, scale, sleeping);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  const color = kind === "bear" ? "#d5b18d" : "#a5cbb1";
  p.oval(ctx, 0, 40, 36, 44, "#9dc4ef");
  if (kind === "bear") {
    p.oval(ctx, -28, -28, 17, 17, color);
    p.oval(ctx, 28, -28, 17, 17, color);
  } else {
    ctx.fillStyle = "#92b59a";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-25 + i * 20, -24);
      ctx.lineTo(-17 + i * 20, -53);
      ctx.lineTo(-4 + i * 20, -24);
      ctx.fill();
    }
  }
  p.oval(ctx, 0, 0, 43, 37, color);
  p.oval(ctx, 0, 14, 23, 16, "#fff3dc");
  if (sleeping) {
    ctx.strokeStyle = "#756568";
    ctx.lineWidth = 3;
    [-16, 16].forEach((a) => {
      ctx.beginPath();
      ctx.moveTo(a - 6, -3);
      ctx.quadraticCurveTo(a, 3, a + 6, -3);
      ctx.stroke();
    });
  } else {
    p.oval(ctx, -16, -3, 3.5, 5, "#756568");
    p.oval(ctx, 16, -3, 3.5, 5, "#756568");
  }
  p.oval(ctx, 0, 8, 4, 3, "#a97e78");
  ctx.restore();
}
function dots(ctx, count, x, y, size = 12) {
  for (let i = 0; i < count; i++) {
    const cols = Math.min(3, count),
      row = Math.floor(i / 3),
      col = i % 3;
    p.oval(
      ctx,
      x + (col - (cols - 1) / 2) * size * 2.7,
      y + (row - (count > 3 ? 0.5 : 0)) * size * 2.7,
      size,
      size,
      "#4777b0",
    );
  }
}
module.exports = { icon, animal, dots, COLORS };

},
"src/feedback-draw.js":function(require,module,exports){
const p = require("./paint");
const { icon } = require("./icons");
const {poseAt,drawCharacter}=require('./character-motion');
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const ease = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;
function events(ui) {
  return ui.feedback ? ui.feedback.events : [];
}
function latest(ui, kind, index) {
  return [...events(ui)]
    .reverse()
    .find((e) => e.kind === kind && (index == null || e.index === index));
}
function moving(ui, index) {
  return [...events(ui)]
    .reverse()
    .find((e) => ["flight", "return"].includes(e.kind) && e.index === index);
}
function withItem(ctx, ui, index, rect, draw) {
  const shake = latest(ui, "shake", index),
    pulse = latest(ui, "pulse", index),
    c = center(rect);
  const dx = shake
    ? Math.sin(shake.progress * Math.PI * 6) * (1 - shake.progress) * 7
    : 0;
  const scale = pulse ? 1 + Math.sin(pulse.progress * Math.PI) * 0.08 : 1;
  ctx.save();
  ctx.translate(c.x + dx, c.y);
  ctx.scale(scale, scale);
  ctx.translate(-c.x, -c.y);
  draw();
  ctx.restore();
}
function withTarget(ctx, ui, value, rect, draw) {
  const event = [...events(ui)]
      .reverse()
      .find((e) => e.kind === "target" && e.value === value),
    c = center(rect);
  const scale = event ? 1 + Math.sin(event.progress * Math.PI) * 0.045 : 1;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(scale, scale);
  ctx.translate(-c.x, -c.y);
  draw();
  ctx.restore();
}
function drawDuo(ctx, image, rect, ui, variant='adventure') {
  const e=latest(ui,'character')||latest(ui,'celebrate');
  const pose=poseAt({elapsed:ui.characterTime==null?ui.time:ui.characterTime,action:e?(e.action||'cheer'):null,progress:e?e.progress:0,still:ui.still});
  drawCharacter(ctx,image,rect,pose,variant);
}
function tint(a, b, t) {
  const parse = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const aa = parse(a),
    bb = parse(b);
  return (
    "#" +
    aa
      .map((n, i) =>
        Math.round(lerp(n, bb[i], t))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function particles(ctx, x, y, t, count = 6) {
  ctx.save();
  ctx.globalAlpha *= Math.sin(Math.PI * t) * 0.75;
  for (let i = 0; i < count; i++) {
    const a = (i * Math.PI * 2) / count,
      d = 12 + 44 * t;
    p.oval(
      ctx,
      x + Math.cos(a) * d,
      y + Math.sin(a) * d - 15 * t,
      2.5,
      2.5,
      i % 2 ? "#fff5cf" : "#f7d775",
    );
  }
  ctx.restore();
}
function movingItem(ctx, e) {
  const t = ease(e.progress),
    a = center(e.from),
    b = center(e.to);
  const arc = e.style === "collect" ? 65 : e.kind === "return" ? 22 : 18;
  const c = {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t) - Math.sin(Math.PI * e.progress) * arc,
  };
  const r = {
    x: c.x - lerp(e.from.w, e.to.w, t) / 2,
    y: c.y - lerp(e.from.h, e.to.h, t) / 2,
    w: lerp(e.from.w, e.to.w, t),
    h: lerp(e.from.h, e.to.h, t),
  };
  ctx.save();
  if (e.style === "collect") {
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.sin(e.progress * Math.PI) * 0.22);
    icon(ctx, e.sprite, 0, 0, lerp(e.spriteSize || 84, 30, t));
    ctx.restore();
    particles(ctx, c.x, c.y, e.progress, 5);
    return;
  }
  ctx.shadowColor = "#9da8c4";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  if (e.style === "pillow" || e.style === "blanket") p[e.style](ctx, r);
  else {
    p.round(ctx, r.x, r.y, r.w, r.h, Math.min(22, r.h / 4), "#fff0cc");
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    icon(ctx, e.sprite, c.x, c.y, Math.min(70, r.h * 0.66));
  }
  ctx.restore();
}
function drawOverlay(ctx, ui, scene) {
  for (const e of events(ui)) {
    if (e.kind === "flight" || e.kind === "return") movingItem(ctx, e);
    if (e.kind === "pulse") {
      const c = center(e.rect);
      particles(ctx, c.x, c.y, e.progress);
    }
    if (e.kind === "match") {
      const [a, b] = e.rects.map(center);
      ctx.save();
      ctx.globalAlpha *= Math.sin(e.progress * Math.PI) * 0.7;
      ctx.strokeStyle = "#fff3b9";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 - 45, b.x, b.y);
      ctx.stroke();
      icon(
        ctx,
        "heart",
        (a.x + b.x) / 2,
        (a.y + b.y) / 2 - 25 - e.progress * 18,
        27,
      );
      ctx.restore();
      e.rects.forEach((r) => {
        const c = center(r);
        particles(ctx, c.x, c.y, e.progress, 5);
      });
    }
    if ((e.kind === "celebrate" && scene === "play") || (e.kind === 'greet' && ['home','play'].includes(scene))) {
      const alpha = Math.min(1, e.progress * 6, (1 - e.progress) * 5);
      const top=scene==='home'?175:205;
      ctx.save();
      ctx.globalAlpha *= alpha;
      p.round(
        ctx,
        35,
        top - Math.sin(e.progress * Math.PI) * 7,
        280,
        50,
        21,
        "#fff6de",
      );
      p.text(ctx, e.text, 175, top+25 - Math.sin(e.progress * Math.PI) * 7, 23);
      ctx.restore();
      particles(ctx, 175, 310, e.progress, 7);
    }
    if (e.kind === "stamp") {
      const x = scene === "goodnight" ? 1090 : 1000,
        y = scene === "goodnight" ? 338 : 205;
      const t = Math.min(1, e.progress / 0.45),
        scale = 1.3 - 0.3 * ease(t) + Math.sin(t * Math.PI) * 0.04;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.rotate(-0.06 * (1 - t));
      ctx.globalAlpha *= Math.min(1, e.progress * 5);
      ctx.lineWidth = 3;
      p.round(ctx, -85, -34, 170, 68, 20, "#e8f2dc", "#83b498");
      p.text(ctx, "✓ 已打卡", 0, 0, 29, "#558568");
      ctx.restore();
    }
  }
}
module.exports = {
  events,
  latest,
  moving,
  withItem,
  withTarget,
  drawDuo,
  drawOverlay,
  tint,
  ease,
};

},
"src/character-motion.js":function(require,module,exports){
// 坐标来自已确认的两张透明角色图；只在绘制时移动前臂，不修改原图片。
const RIGS={
 adventure:{width:1201,height:1309,bones:[
  {name:'zeroArm',pivot:[874,393],radius:26,points:[[850,357],[919,308],[1048,293],[1070,323],[1065,435],[955,454],[873,439],[839,420]]},
  {name:'childArm',pivot:[943,753],radius:30,points:[[984,540],[1160,540],[1160,745],[1030,802],[944,806],[920,768],[936,721],[968,676],[984,642]]}
 ]},
 bedtime:{width:1312,height:1199,bones:[]}
};

function poseAt({elapsed=0,action=null,progress=0,still=false}={}){
 if(still)return {zeroArm:0,childArm:0,jump:0,lean:0,breathe:0};
 const cycle=((elapsed%6500)+6500)%6500;
 const waving=action==='wave'||(!action&&cycle<2200);
 const t=action==='wave'?progress:cycle/2200;
 const envelope=waving?Math.sin(Math.PI*Math.max(0,Math.min(1,t))):0;
 const wave=waving?Math.sin(t*Math.PI*4)*envelope:0;
 const cheer=action==='cheer'?Math.sin(Math.PI*progress):0;
 return {
  zeroArm:wave*0.38-cheer*0.30,
  childArm:-Math.abs(wave)*0.60-cheer*0.45,
  jump:action==='cheer'?-Math.abs(Math.sin(progress*Math.PI*2))*25:0,
  lean:wave*0.012,
  breathe:Math.sin(elapsed/1200)*2,
 };
}
function characterRect(scene){
 if(scene==='home')return {x:35,y:230,w:325,h:380};
 if(scene==='goodnight'||scene==='ended')return {x:390,y:210,w:500,h:365};
 return {x:16,y:260,w:310,h:335};
}
function area(points){return points.reduce((sum,a,i)=>{const b=points[(i+1)%points.length];return sum+a[0]*b[1]-b[0]*a[1];},0);}
function trace(ctx,points,hole=false){
 const list=hole&&area(points)>0?points.slice().reverse():points;
 ctx.moveTo(list[0][0],list[0][1]);for(let i=1;i<list.length;i++)ctx.lineTo(list[i][0],list[i][1]);ctx.closePath();
}
function drawCharacter(ctx,image,rect,pose,variant='adventure'){
 if(!image||!image.width||!image.height)return;
 const rig=RIGS[variant]||RIGS.adventure;
 const scale=Math.min(rect.w/rig.width,rect.h/rig.height);
 const x=rect.x+(rect.w-rig.width*scale)/2,y=rect.y+rect.h-rig.height*scale+pose.jump+pose.breathe;
 ctx.save();ctx.translate(x+rig.width*scale/2,y+rig.height*scale);ctx.rotate(pose.lean);ctx.translate(-rig.width*scale/2,-rig.height*scale);ctx.scale(scale,scale);
 const active=rig.bones.filter(b=>Math.abs(pose[b.name])>0.001);
 if(!active.length){ctx.drawImage(image,0,0,rig.width,rig.height);ctx.restore();return;}
 ctx.save();ctx.beginPath();ctx.rect(0,0,rig.width,rig.height);active.forEach(b=>trace(ctx,b.points,true));ctx.clip();ctx.drawImage(image,0,0,rig.width,rig.height);ctx.restore();
 for(const bone of active){
  const [px,py]=bone.pivot;
  // 固定的小关节覆盖接缝，使用同一原图纹理。
  ctx.save();ctx.beginPath();ctx.arc(px,py,bone.radius,0,Math.PI*2);ctx.clip();ctx.drawImage(image,0,0,rig.width,rig.height);ctx.restore();
  ctx.save();ctx.translate(px,py);ctx.rotate(pose[bone.name]);ctx.translate(-px,-py);ctx.beginPath();trace(ctx,bone.points);ctx.clip();ctx.drawImage(image,0,0,rig.width,rig.height);ctx.restore();
 }
 ctx.restore();
}
module.exports={poseAt,drawCharacter,characterRect,RIGS};

},
"src/feedback.js":function(require,module,exports){
const rules = require("./challenges");
const EFFECT_KEYS = [
  "tap",
  "collect",
  "place",
  "flip",
  "match",
  "retry",
  "win",
  "checkin",
  "sleep",
  "note-blue",
  "note-coral",
  "note-yellow",
  "note-green",
];
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const copy = (value) => JSON.parse(JSON.stringify(value));

// 动画和待播音效只存在于内存；业务进度仍由原状态机即时保存。
function createFeedback(now) {
  let events = [],
    sounds = [],
    serial = 0;
  function prune() {
    const time = now();
    events = events.filter((e) => time < e.start + e.duration);
  }
  return {
    add(kind, data = {}, duration = 400, delay = 0) {
      prune();
      if (
        ["flight", "return", "flip", "shake", "pulse"].includes(kind) &&
        data.index != null
      )
        events = events.filter(
          (e) => !(e.index === data.index && e.kind === kind),
        );
      events.push({
        ...copy(data),
        kind,
        id: ++serial,
        start: now() + delay,
        duration,
      });
      if (events.length > 24) events.splice(0, events.length - 24);
    },
    sound(key, delay = 0) {
      if (EFFECT_KEYS.includes(key)) sounds.push({ key, at: now() + delay });
      if (sounds.length > 12) sounds.splice(0, sounds.length - 12);
    },
    drainSounds() {
      const time = now(),
        due = sounds.filter((s) => s.at <= time);
      sounds = sounds.filter((s) => s.at > time);
      return due.map((s) => s.key);
    },
    clearSounds() {
      sounds = [];
    },
    removeIndex(index) {
      events = events.filter(
        (e) =>
          !(e.index === index && ["return", "shake", "pulse"].includes(e.kind)),
      );
    },
    clear() {
      events = [];
      sounds = [];
    },
    snapshot() {
      prune();
      const time = now();
      return {
        events: events
          .filter((e) => e.start <= time)
          .map((e) => ({
            ...copy(e),
            age: time - e.start,
            progress: Math.min(1, Math.max(0, (time - e.start) / e.duration)),
          })),
        pendingSounds: sounds.map((s) => ({ ...s })),
      };
    },
  };
}

function actionFeedback(l, before, after, action, layout, meta = {}) {
  const events = [],
    sounds = [];
  const emit = (kind, data = {}, duration = 400, delay = 0) =>
    events.push({ kind, data, duration, delay });
  if (!before || rules.complete(l, before)) return { events, sounds };
  const changed = before !== after,
    index = action.index,
    r = layout.items[index];
  const retry = () => {
    if (r) emit("shake", { index, rect: r }, 330);
    sounds.push("retry");
  };
  if (l.type === "find" && action.type === "pick" && r) {
    if (changed) {
      emit(
        "flight",
        {
          index,
          sprite: l.items[index],
          style: "collect",
          from: r,
          to: { x: 1162, y: 37, w: 40, h: 40 },
        },
        600,
      );
      sounds.push("collect");
    } else if (!before.found.includes(index)) retry();
  }
  if (
    ["bridge", "sort"].includes(l.type) &&
    action.type === "place" &&
    r &&
    !before.placed.includes(index)
  ) {
    const sprite = l.type === "bridge" ? l.items[index] : l.items[index].icon;
    const from = meta.from || r;
    if (changed) {
      const target = layout.targets.find((t) => t.value === action.target),
        c = center(target);
      const to =
        l.type === "bridge"
          ? target
          : { x: c.x - 30, y: c.y - 42, w: 60, h: 60 };
      emit("flight", { index, sprite, style: l.type, from, to }, 420);
      emit("target", { value: action.target, rect: target }, 360, 300);
      sounds.push("place");
    } else {
      emit("return", { index, sprite, style: l.type, from, to: r }, 300);
      sounds.push("retry");
    }
  }
  if (l.type === "count" && action.type === "answer") {
    const item = layout.items.find((x) => x.value === action.value);
    if (item) {
      emit(
        changed ? "pulse" : "shake",
        { index: item.index, rect: item },
        changed ? 500 : 330,
      );
      sounds.push(changed ? "match" : "retry");
    }
  }
  if (l.type === "memory") {
    if (action.type === "flip" && changed) {
      emit("flip", { index, rect: r, fromShown: false, toShown: true }, 250);
      sounds.push("flip");
      if (after.matched.length > before.matched.length) {
        const indices = after.matched.filter(
          (i) => !before.matched.includes(i),
        );
        emit(
          "match",
          { indices, rects: indices.map((i) => layout.items[i]) },
          750,
          180,
        );
        sounds.push("match");
      } else if (after.open.length === 2) sounds.push("retry");
    }
    if (action.type === "close" && changed)
      before.open.forEach((i) =>
        emit(
          "flip",
          { index: i, rect: layout.items[i], fromShown: true, toShown: false },
          250,
        ),
      );
  }
  if (
    l.type === "sequence" &&
    action.type === "color" &&
    before.mode === "input"
  ) {
    const item = layout.items.find((x) => x.value === action.value);
    if (item) {
      emit(
        after.mode === "demo" ? "shake" : "pulse",
        { index: item.index, rect: item },
        350,
      );
      sounds.push(after.mode === "demo" ? "retry" : "note-" + action.value);
    }
  }
  if (l.type === "order" && action.type === "pick" && r) {
    if (changed) {
      emit(
        "flight",
        {
          index,
          sprite: l.icon,
          style: "collect",
          from: r,
          to: { x: 1162, y: 37, w: 40, h: 40 },
          spriteSize: l.sizes[index] * 2,
        },
        520,
      );
      sounds.push("collect");
    } else if (!before.picked.includes(index)) retry();
  }
  if (l.type === "care" && changed && action.type === "care") {
    const item = layout.items.find((x) => x.value === action.item);
    if (action.item === "lamp") {
      emit("sleep", {}, 900);
      sounds.push("sleep");
    } else {
      const target = layout.targets.find((x) => x.value === action.item);
      emit(
        "flight",
        {
          index: item.index,
          sprite: action.item,
          style: action.item,
          from: meta.from || item,
          to: target,
        },
        action.item === "blanket" ? 700 : 480,
      );
      sounds.push("place");
    }
  } else if (l.type === "care" && action.type === "place" && r) {
    emit(
      "return",
      { index, sprite: r.value, style: r.value, from: meta.from || r, to: r },
      300,
    );
    sounds.push("retry");
  }
  return { events, sounds };
}
module.exports = { createFeedback, actionFeedback, EFFECT_KEYS };

},
"preview/platform-browser.js":function(require,module,exports){
const { localDate } = require("../src/calendar");
const { createBrowserAudio } = require("./browser-audio");
const STORAGE_KEY = "xiaoming-bedtime-preview-v1";
function createBrowserPlatform(canvas) {
  const sound = createBrowserAudio();
  const imageCache = new Map(), imageLoads = new Set();
  const listen = (target, type, cb, options) => {
    target.addEventListener(type, cb, options);
    return () => target.removeEventListener(type, cb, options);
  };
  return {
    canvas,
    ctx: canvas.getContext("2d"),
    now: () => performance.now(),
    today: () => localDate(),
    getViewport: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }),
    load() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY));
      } catch (_) {
        return null;
      }
    },
    save: (data) => localStorage.setItem(STORAGE_KEY, JSON.stringify(data)),
    loadImage(src) {
      if (imageCache.has(src)) return imageCache.get(src);
      const configured = window.__GAME_IMAGE_PATHS__ && window.__GAME_IMAGE_PATHS__[src];
      const candidates = Array.isArray(configured) && configured.length ? configured : [src];
      const pending = new Promise((resolve, reject) => {
        let image = null, timer = null, index = 0, done = false;
        function cleanup(cancel = false) {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          if (image) { image.onload = null; image.onerror = null; if (cancel) image.src = ""; }
        }
        function finish(error, value) {
          if (done) return;
          done = true; cleanup(!!error); imageLoads.delete(cancel);
          if (error) reject(error); else resolve(value);
        }
        const cancel = () => finish(new Error("图片加载已取消"));
        imageLoads.add(cancel);
        function attempt() {
          if (done) return;
          cleanup(true);
          if (index >= candidates.length) { finish(new Error("图片加载失败，请重试")); return; }
          let url;
          try { url = new URL(candidates[index++], document.baseURI).href; }
          catch (error) { finish(error); return; }
          image = new Image(); image.decoding = "async";
          image.onload = () => finish(null, image);
          image.onerror = attempt;
          timer = setTimeout(attempt, 45000);
          image.src = url;
        }
        attempt();
      });
      const cached = pending.catch(error => { imageCache.delete(src); throw error; });
      imageCache.set(src, cached);
      return cached;
    },
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onPointer(callback) {
      const offs = [
        ["pointerdown", "down"],
        ["pointermove", "move"],
        ["pointerup", "up"],
        ["pointercancel", "cancel"],
      ].map(([name, type]) =>
        listen(
          canvas,
          name,
          (e) => {
            if (type === "up" && e.isTrusted !== false) sound.unlockAudio();
            e.preventDefault();
            if (type === "down") {
              try {
                canvas.setPointerCapture(e.pointerId);
              } catch (_) {}
            }
            const rect = canvas.getBoundingClientRect();
            callback({
              type,
              id: e.pointerId,
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            });
          },
          { passive: false },
        ),
      );
      // iOS可能只把touchend认作媒体播放手势；保留原生事件作为兼容入口。
      const unlock = e => { if (e.isTrusted !== false) sound.unlockAudio(); };
      offs.push(listen(canvas,"touchend",unlock,{passive:true}),listen(canvas,"click",unlock));
      return () => offs.forEach((off) => off());
    },
    onHide: (cb) =>
      listen(document, "visibilitychange", () => {
        if (document.hidden) cb();
      }),
    onShow: (cb) =>
      listen(document, "visibilitychange", () => {
        if (!document.hidden) cb();
      }),
    onResize: (cb) => listen(window, "resize", cb),
    unlockAudio: sound.unlockAudio,
    getAudioState: sound.getAudioState,
    playAudio: sound.playAudio,
    playEffect: sound.playEffect,
    stopEffects: sound.stopEffects,
    stopAudio: sound.stopAudio,
    destroy() {
      for (const cancel of imageLoads) cancel();
      imageCache.clear();
      sound.destroy();
    },
  };
}
module.exports = { createBrowserPlatform };

},
"preview/browser-audio.js":function(require,module,exports){
const { EFFECT_KEYS } = require('../src/feedback');
const VOICE_KEYS = ['welcome','stars','bridge','pillow','blanket','lamp','success','goodnight','find','count','sort','memory','sequence','order','daycomplete','finished'];
const NOTES = {
  tap:[[0,660,.11,.7]], collect:[[0,880,.24,.8],[.075,1174.66,.27,.65]],
  place:[[0,392,.16,.8],[.035,587.33,.18,.35]], flip:[[0,520,.09,.35],[.025,780,.08,.25]],
  match:[[0,659.25,.24,.65],[.07,783.99,.24,.65],[.14,1046.5,.28,.6]],
  retry:[[0,493.88,.16,.45],[.07,392,.2,.35]],
  win:[[0,523.25,.25,.6],[.09,659.25,.27,.6],[.18,783.99,.3,.55],[.27,1046.5,.32,.4]],
  checkin:[[0,523.25,.27,.6],[.12,783.99,.3,.5],[.24,1046.5,.32,.5],[.36,1318.51,.35,.3]],
  sleep:[[0,783.99,.32,.3],[.14,659.25,.38,.25],[.28,523.25,.48,.2]],
  'note-blue':[[0,523.25,.28,.7]], 'note-coral':[[0,587.33,.28,.7]],
  'note-yellow':[[0,659.25,.28,.7]], 'note-green':[[0,783.99,.28,.7]],
};
// HTMLAudio后备也在真实手势中播放一小段静音PCM，以解锁每个媒体实例。
const SILENCE = 'data:audio/wav;base64,UklGRiQCAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

function createBrowserAudio(options = {}) {
  const scope = typeof window !== 'undefined' ? window : {};
  const Context = Object.prototype.hasOwnProperty.call(options,'AudioContext')
    ? options.AudioContext : scope.AudioContext || scope.webkitAudioContext;
  const Media = options.Audio || (typeof Audio !== 'undefined' ? Audio : null);
  const nav = options.navigator || (typeof navigator !== 'undefined' ? navigator : {});
  const fetcher = options.fetch || ((...args) => fetch(...args));
  const baseURI = options.baseURI || (() => typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
  const clock = options.now || (() => typeof performance !== 'undefined' ? performance.now() : Date.now());
  let context = null, voiceGain = null, effectGain = null, unlockPromise = null;
  let unlockGeneration = 0, unlockStarted = 0;
  let destroyed = false, attempted = false, failure = null, failureOwner = null, voiceLoading = false;
  let voiceToken = 0, effectToken = 0, voiceSource = null, pendingVoice = null;
  let htmlVoice = null, htmlCursor = 0, htmlStarted = false;
  const activeEffects = new Set(), voiceCache = new Map(), effectCache = new Map();
  const requests = new Set(), htmlEffects = [];
  const engine = Context ? 'web-audio' : 'html-audio';
  const url = (kind,key) => new URL(`assets/${kind}/${key}.mp3`,baseURI()).href;

  function fail(error, owner = null) {
    if (destroyed) return;
    const name = error && error.name || 'Error';
    if (name === 'AbortError') return;
    if (owner && failureOwner === htmlVoice && owner !== htmlVoice) return;
    failureOwner = owner;
    failure = {name,message:String(error && error.message || '声音暂时不可用')};
  }
  function clearBlocked() {
    if (failure && failure.name === 'NotAllowedError') { failure = null; failureOwner = null; }
  }
  function getAudioState() {
    const contextState = destroyed ? 'closed' : context ? context.state : Context ? 'uninitialized' : 'unavailable';
    let status = 'locked';
    if (!destroyed) {
      if (failure) status = failure.name === 'NotAllowedError' ? 'blocked' : 'error';
      else if (Context && contextState !== 'running')
        status = unlockPromise && clock() - unlockStarted < 2000 ? 'unlocking' : attempted ? 'blocked' : 'locked';
      else if (voiceLoading) status = 'loading';
      else if (Context || htmlStarted) status = 'ready';
    }
    return {status,engine,contextState,contextTime:context ? context.currentTime : 0,voicePlaying:!!voiceSource || !!(htmlVoice && htmlVoice.playing),effectPlaying:activeEffects.size + htmlEffects.filter(x=>x.playing).length,lastError:failure && {...failure}};
  }
  function stopNode(node) {
    if (!node) return;
    try { node.stop(); } catch (_) {}
    try { node.disconnect(); } catch (_) {}
  }
  function stopVoice() {
    voiceToken++; pendingVoice = null; voiceLoading = false;
    stopNode(voiceSource); voiceSource = null;
    if (htmlVoice) stopMedia(htmlVoice);
  }
  function stopEffects() {
    effectToken++;
    for (const node of [...activeEffects]) stopNode(node);
    activeEffects.clear(); htmlEffects.forEach(stopMedia);
  }
  function stopAudio() { stopVoice(); stopEffects(); }

  function makeContext() {
    if (context) return;
    context = new Context();
    voiceGain = context.createGain(); voiceGain.gain.value = .85; voiceGain.connect(context.destination);
    effectGain = context.createGain(); effectGain.gain.value = .45; effectGain.connect(context.destination);
  }
  function decode(bytes) {
    return new Promise((resolve,reject) => {
      if (destroyed || !context || context.state === 'closed') { reject(Object.assign(new Error('声音已关闭'),{name:'AbortError'})); return; }
      try {
        const result = context.decodeAudioData(bytes.slice(0),resolve,reject);
        if (result && result.then) result.then(resolve,reject);
      } catch (error) { reject(error); }
    });
  }
  function loadVoice(key) {
    if (voiceCache.has(key)) return voiceCache.get(key);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller) requests.add(controller);
    const timer = setTimeout(() => { if (controller) controller.abort(); },20000);
    let response;
    try { response = fetcher(url('audio',key),controller ? {signal:controller.signal} : {}); }
    catch (error) { response = Promise.reject(error); }
    const pending = Promise.resolve(response).then(r=>{
      if (!r.ok) throw new Error('语音加载失败，请点声音按钮重试');
      return r.arrayBuffer();
    }).then(decode).catch(error=>{
      voiceCache.delete(key);
      if (error && error.name === 'AbortError' && !destroyed) throw new Error('语音加载超时，请点声音按钮重试');
      throw error;
    }).finally(()=>{clearTimeout(timer);if(controller)requests.delete(controller);});
    voiceCache.set(key,pending); return pending;
  }
  function drainVoice() {
    if (destroyed || !pendingVoice || !context || context.state !== 'running') return;
    const job = pendingVoice; pendingVoice = null; voiceLoading = true;
    loadVoice(job.key).then(buffer=>{
      if (destroyed || job.token !== voiceToken) return;
      if (context.state !== 'running') { pendingVoice = job; voiceLoading = false; return; }
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(voiceGain);
      node.onended = () => { if (voiceSource === node) voiceSource = null; try { node.disconnect(); } catch (_) {} };
      voiceSource = node; node.start(); voiceLoading = false; failure = null;
    }).catch(error=>{
      if (!destroyed && job.token === voiceToken) { voiceLoading = false; fail(error); }
    });
  }
  function unlockAudio() {
    if (destroyed) return Promise.resolve(false);
    attempted = true;
    try { if (nav.audioSession) nav.audioSession.type = 'playback'; } catch (_) {}
    if (!Context) return unlockHtml();
    // 未获播放许可的resume可能一直pending；新手势必须能够重新尝试。
    const generation = ++unlockGeneration;
    unlockPromise = null;
    try {
      makeContext();
      if (context.state === 'running') { clearBlocked(); drainVoice(); return Promise.resolve(true); }
      // resume必须在事件回调内同步调用，不能先等待语音下载。
      unlockStarted = clock();
      const resumed = context.resume();
      const pending = Promise.resolve(resumed).then(()=>{
        if (destroyed || generation !== unlockGeneration) return false;
        if (context.state !== 'running') throw Object.assign(new Error('请点一下声音按钮开启声音'),{name:'NotAllowedError'});
        clearBlocked(); drainVoice(); return true;
      }).catch(error=>{if(generation===unlockGeneration)fail(error);return false;}).finally(()=>{if(generation===unlockGeneration&&unlockPromise===pending)unlockPromise=null;});
      unlockPromise = pending; return pending;
    } catch(error) { fail(error); return Promise.resolve(false); }
  }
  function playAudio(key) {
    if (destroyed || !VOICE_KEYS.includes(key)) return;
    failure = null; failureOwner = null; stopVoice();
    if (!Context) {
      try { if (!htmlVoice) htmlVoice = makeMedia(.85); voiceLoading = true; playMedia(htmlVoice,url('audio',key)); }
      catch(error){voiceLoading = false; fail(error);} return;
    }
    pendingVoice = {key,token:voiceToken}; voiceLoading = true;
    drainVoice();
  }
  function synthesize(key) {
    if (effectCache.has(key)) return effectCache.get(key);
    const notes = NOTES[key], rate = context.sampleRate;
    const duration = Math.max(...notes.map(([start,,length])=>start+length)) + .04;
    const buffer = context.createBuffer(1,Math.ceil(duration*rate),rate),data=buffer.getChannelData(0);
    let peak=0;
    for (const [start,freq,length,gain] of notes) {
      const offset=Math.floor(start*rate);
      for(let i=0;i<Math.floor(length*rate);i++){
        const t=i/rate,env=Math.min(1,t/.008)*Math.min(1,(length-t)/.035)*Math.exp(-4.2*t/length);
        data[offset+i]+=gain*env*(Math.sin(2*Math.PI*freq*t)+.16*Math.sin(4*Math.PI*freq*t)*Math.exp(-12*t));
      }
    }
    for(const sample of data)peak=Math.max(peak,Math.abs(sample));
    const amplitude=['retry','sleep'].includes(key)?.23:.36;
    if(peak)for(let i=0;i<data.length;i++)data[i]=data[i]/peak*amplitude;
    effectCache.set(key,buffer);return buffer;
  }
  function startEffect(key,token) {
    if (destroyed || token !== effectToken || !context || context.state !== 'running') return;
    try {
      if(activeEffects.size>=6){const oldest=activeEffects.values().next().value;activeEffects.delete(oldest);stopNode(oldest);}
      const node=context.createBufferSource();node.buffer=synthesize(key);node.connect(effectGain);
      node.onended=()=>{activeEffects.delete(node);try{node.disconnect();}catch(_){}};
      activeEffects.add(node);node.start();
    } catch(error){fail(error);}
  }
  function playEffect(key) {
    if(destroyed || !EFFECT_KEYS.includes(key))return;
    if(!Context){
      try { const i=htmlCursor++%2;if(!htmlEffects[i])htmlEffects[i]=makeMedia(.45);playMedia(htmlEffects[i],url('sfx',key)); }catch(error){fail(error);}return;
    }
    const token=effectToken,requestedAt=clock();
    if(context && context.state==='running')startEffect(key,token);
    else if(unlockPromise)unlockPromise.then(ok=>{if(ok&&clock()-requestedAt<500)startEffect(key,token);});
  }

  function makeMedia(volume) {
    if(!Media)throw new Error('浏览器暂不支持声音播放');
    const media=new Media(),channel={media,generation:0,playing:false,primed:false,pending:false};
    media.volume=volume;media.preload='auto';
    if(media.setAttribute)media.setAttribute('playsinline','');
    media.onended=()=>{channel.playing=false;};
    media.onerror=()=>{channel.playing=false;if(channel===htmlVoice)voiceLoading=false;if(!destroyed)fail(new Error('声音加载失败，请点击重试'),channel);};
    return channel;
  }
  function stopMedia(channel) {
    channel.generation++;channel.playing=false;channel.pending=false;
    try{channel.media.pause();channel.media.currentTime=0;}catch(_){}
  }
  function playMedia(channel,src,prime=false) {
    stopMedia(channel);const token=channel.generation;
    channel.media.src=src;
    channel.pending=true;
    let result;
    try{result=channel.media.play();}catch(error){channel.pending=false;if(channel===htmlVoice)voiceLoading=false;fail(error,channel);return Promise.resolve(false);}
    return Promise.resolve(result).then(()=>{
      if(destroyed||token!==channel.generation)return false;
      channel.pending=false;
      if(channel===htmlVoice&&!prime)voiceLoading=false;
      channel.primed=true;htmlStarted=true;
      if(!failure || failureOwner===channel){failure=null;failureOwner=null;}
      if(prime){channel.media.pause();channel.playing=false;}else channel.playing=true;
      return true;
    }).catch(error=>{if(!destroyed&&token===channel.generation){channel.pending=false;if(channel===htmlVoice)voiceLoading=false;fail(error,channel);}return false;});
  }
  function unlockHtml() {
    try{
      if(!htmlVoice)htmlVoice=makeMedia(.85);
      for(let i=0;i<2;i++)if(!htmlEffects[i])htmlEffects[i]=makeMedia(.45);
      const pending=[htmlVoice,...htmlEffects].filter(x=>!x.primed&&!x.playing&&!x.pending).map(x=>playMedia(x,SILENCE,true));
      return Promise.all(pending).then(results=>results.every(Boolean));
    }catch(error){fail(error);return Promise.resolve(false);}
  }
  function destroy() {
    if(destroyed)return;destroyed=true;unlockGeneration++;unlockPromise=null;stopAudio();
    for(const controller of requests)controller.abort();requests.clear();voiceCache.clear();effectCache.clear();
    if(context){try{const closed=context.close();if(closed&&closed.catch)closed.catch(()=>{});}catch(_){};}
    for(const gain of [voiceGain,effectGain]){try{gain&&gain.disconnect();}catch(_){}}
    for(const channel of [htmlVoice,...htmlEffects])if(channel){channel.media.onended=null;channel.media.onerror=null;try{channel.media.removeAttribute('src');channel.media.load();}catch(_){}}
  }
  return {unlockAudio,getAudioState,playAudio,playEffect,stopEffects,stopAudio,destroy};
}
module.exports={createBrowserAudio};

}},mapping={"preview/entry.js":{"../src/game":"src/game.js","./platform-browser":"preview/platform-browser.js"},"src/game.js":{"./model":"src/model.js","./challenges":"src/challenges.js","./calendar":"src/calendar.js","./layout":"src/layout.js","./challenge-layout":"src/challenge-layout.js","./draw":"src/draw.js","./character-motion":"src/character-motion.js","./feedback":"src/feedback.js"},"src/model.js":{"./levels":"src/levels.js","./challenges":"src/challenges.js","./calendar":"src/calendar.js"},"src/levels.js":{},"src/challenges.js":{},"src/calendar.js":{},"src/layout.js":{},"src/challenge-layout.js":{},"src/draw.js":{"./layout":"src/layout.js","./model":"src/model.js","./challenges":"src/challenges.js","./levels":"src/levels.js","./challenge-draw":"src/challenge-draw.js","./paint":"src/paint.js","./feedback-draw":"src/feedback-draw.js","./character-motion":"src/character-motion.js"},"src/challenge-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./challenges":"src/challenges.js","./feedback-draw":"src/feedback-draw.js"},"src/paint.js":{},"src/icons.js":{"./paint":"src/paint.js"},"src/feedback-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./character-motion":"src/character-motion.js"},"src/character-motion.js":{},"src/feedback.js":{"./challenges":"src/challenges.js"},"preview/platform-browser.js":{"../src/calendar":"src/calendar.js","./browser-audio":"preview/browser-audio.js"},"preview/browser-audio.js":{"../src/feedback":"src/feedback.js"}},cache={};function load(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](name=>load(mapping[id][name]),module,module.exports);return module.exports;}load("preview/entry.js");})();