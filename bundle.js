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
const {PARENT_UI}=require("./parent-panel");
const {characterRect}=require('./character-motion');
const { createFeedback, actionFeedback } = require("./feedback");
const {heroForState} = require('./heroes');
const {createVoicePicker} = require('./voice-picker');
const variety=require('./variety-challenges');
const varietyLayout=require('./variety-layout');
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
    parentPanel = null,
    message = "",
    messageUntil = 0,
    generation = 0,
    demoStart = 0,
    mismatchUntil = 0,
    peekUntil = 0,
    demoToneStep = -1,
    checkinPlayedFor = -1;
  let characterEpoch = 0;
  let brushFeedbackAt = -Infinity;
  const voicePicker = createVoicePicker(platform.random || Math.random);
  let currentVoice = null;
  const images = {}, imageRequests = {},
    unsubscribe = [];
  const now = () => platform.now(),
    copy = (v) => JSON.parse(JSON.stringify(v));
  const feedback = createFeedback(now);
  const level = () => model.currentLevel(state),
    layout = () => layoutFor(level());
  const visibleImage = () => heroForState(state)[["goodnight", "ended"].includes(state.scene) ? "bedtime" : "adventure"];
  function clearPointer() { pointer = null; }
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
    if(!meta.quiet)result.sounds.forEach((key, index) => effect(key, index * 120));
    if (!meta.quiet && model.progress(next) > model.progress(old))
      feedback.add('character', {action:'cheer'}, 1200);
    if (!model.isComplete(old) && model.isComplete(next)) {
      const last = model.currentLevel(old).index === 19;
      if(!last){
        const completed=next.completed.slice();completed[next.day]++;
        fetchImage(heroForState({...next,completed}).adventure).catch(()=>{});
      }
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
      parentPanel ||
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
      hero: heroForState(state),
      time: now(),
      characterTime: now() - characterEpoch,
      audio: audioState(),
      today: today(),
      layout: layout(),
      selected,
      drag: pointer && pointer.index != null ? pointer : null,
      parentPanel,
      message: now() < messageUntil ? message : "",
      loading,
      error,
      peek: now() < peekUntil,
      activeColor: activeColor(),
      feedback: visualFeedback,
      still: state.scene === "ended" || !!parentPanel,
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
      (state.scene !== "ended" || parentPanel !== null)
    )
      frame = platform.requestFrame(tick);
  }
  function tick() {
    frame = null;
    if (destroyed || hidden) return;
    if (ready && !parentPanel && state.scene === "play" && !model.isComplete(state)) {
      if(level().type==='hide'&&state.challenge.mode==='preview'&&now()>=demoStart+2200)
        change({type:'challenge',action:{type:'previewDone'}});
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
    if (hidden || state.muted || state.scene === "ended") return;
    const base = model.voiceKey(state);
    if (!currentVoice || currentVoice.base !== base)
      currentVoice = {base, key:voicePicker.next(base)};
    if (currentVoice.key) platform.playAudio(currentVoice.key);
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
      currentVoice = null;
      parentPanel = null;
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
      if(level().type==='hide'&&state.challenge.mode==='preview'&&(moved||action.action&&action.action.type==='replay'))demoStart=now()+900;
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
    if (loading || error || !ready) {
      // 切回已缓存的伙伴时，旧图片请求不能覆盖当前画面的状态。
      generation++;
      ready = true;
      loading = false;
      error = false;
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
    if (parentPanel || state.scene !== "play" || model.isComplete(state)) return null;
    const l = level(),
      c = state.challenge;
    if(l.type==='share'){
      const item=layout().items.find(r=>!c.given.some(x=>x.index===r.index)&&contains(r,point));
      return item?item.index:null;
    }
    if (["bridge", "sort", "puzzle"].includes(l.type)) {
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
    if(target&&l.type==='share')ok=change({type:'challenge',action:{type:'give',index,target:target.value}},{from});
    if (target && ["bridge", "sort", "puzzle"].includes(l.type))
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
        { type: l.type==='share'?'give':'place', index, target: target && target.value },
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
        l.type === "share" ? "每位伙伴只要一份，找还没分到的伙伴吧。" : l.type === "care"
          ? "放到伙伴的床上试试吧！"
          : "找一找，相同的图案在哪里？",
      );
    return ok;
  }
  function closeParent() {
    parentPanel = null; clearPointer(); selected = null; clearFeedback();
    if(state.scene==='play'&&!model.isComplete(state)){
      if(level().type==='memory')change({type:'challenge',action:{type:'close'}});
      if(level().type==='sequence')change({type:'challenge',action:{type:'replay'}});
      if(level().type==='hide')change({type:'challenge',action:{type:'replay'}});
    }
    resetTemporal();
    if(state.scene==='ended')stopLoop();else{if(ready)speak();schedule();}
    draw();
  }
  function parentControlAt(point){
    if(!parentPanel)return contains(UI.parentMenu,point,8)?UI.parentMenu:null;
    const names=parentPanel==='menu'?['close','back','reset','next']:['close','cancel','confirm'];
    return names.map(name=>PARENT_UI[name]).find(r=>contains(r,point,6))||null;
  }
  // 点击必须从同一个可交互区域开始并结束，避免手指漂移误选相邻按钮。
  function tapAreaAt(point) {
    const parentControl = parentControlAt(point);
    if (parentControl) return parentControl;
    if (parentPanel) return null;
    let areas;
    if (error) areas = [UI.retry];
    else if (!ready) return null;
    else if (state.scene === "home") areas = [characterRect(state.scene), UI.mute, ...DAYS, UI.start];
    else if (state.scene === "goodnight") areas = [characterRect(state.scene), UI.end];
    else if (state.scene === "ended") return null;
    else {
      areas = [characterRect(state.scene), UI.back, UI.mute];
      if (model.isComplete(state)) areas.push(UI.next);
      else {
        const map = layout();
        areas.push(UI.speaker);
        if (["sequence", "memory", "maze", "puzzle"].includes(level().type)) areas.push(map.help);
        if(variety.isVariety(level().type)){if(map.help)areas.push(map.help);areas.push(...map.controls);}
        if (level().type === "count") areas.push(...map.objects);
        areas.push(...map.items, ...map.targets.map(r => selected === null ? r : {
          ...r, x: r.x - 18, y: r.y - 18, w: r.w + 36, h: r.h + 36,
        }));
      }
    }
    return areas.find(r => contains(r, point)) ||
      (state.scene === "play" && selected !== null ? { x: 0, y: 0, w: WIDTH, h: HEIGHT } : null);
  }
  function trackPointer(point) {
    if (!point) {
      pointer.leftCanvas = true;
      pointer.moved = true;
      return;
    }
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.maxDistance = Math.max(pointer.maxDistance,
      Math.hypot(point.x - pointer.startX, point.y - pointer.startY) * viewport.scale);
    // 采用屏幕像素，手机缩放后不会把轻微手抖误判为拖动。
    if (pointer.maxDistance > 12) pointer.moved = true;
  }
  function parentClick(point){
    if(contains(PARENT_UI.close,point,6)||parentPanel==='menu'&&contains(PARENT_UI.back,point,6)){closeParent();return;}
    if(parentPanel==='menu'){
      if(contains(PARENT_UI.reset,point,6))parentPanel='reset-confirm';
      else if(contains(PARENT_UI.next,point,6)&&model.needsParent(state))parentPanel='next-confirm';
    }else if(contains(PARENT_UI.cancel,point,6))parentPanel='menu';
    else if(contains(PARENT_UI.confirm,point,6)){
      const reset=parentPanel==='reset-confirm';parentPanel=null;
      change({type:reset?'reset':'parentContinue'});
    }
    draw();schedule();
  }
  function click(point, audioStatusAtPress) {
    if(!point)return;
    if(parentPanel){parentClick(point);return;}
    if(contains(UI.parentMenu,point,8)){
      parentPanel='menu';clearPointer();selected=null;clearFeedback();platform.stopAudio();draw();schedule();return;
    }
    if (error) { if (contains(UI.retry, point)) loadImages(true); return; }
    if (!ready) return;
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
          if(model.needsParent(state)){parentPanel='menu';draw();}else hint("先完成前一组冒险吧");
        return;
      }
      if (contains(UI.start, point)) {if(model.needsParent(state)){parentPanel="menu";draw();}else change({ type: "start" });}
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
    if (["sequence", "memory", "maze", "puzzle"].includes(l.type) && contains(map.help, point)) {
      effect("tap");
      flushEffects();
      if (l.type === "sequence") {
        change({ type: "challenge", action: { type: "replay" } });
        speak();
      } else {
        if(l.type==='memory')change({ type: "challenge", action: { type: "close" } });
        peekUntil = now() + 1800;
        draw();
      }
      return;
    }
    if (selected !== null) {
      place(selected, point);
      return;
    }
    if(variety.isVariety(l.type)){
      const action=varietyLayout.actionAt(l,state.challenge,map,point);
      if(!action)return;
      if(action.type==='hint'){peekUntil=now()+2200;effect('tap');flushEffects();draw();return;}
      if(!change({type:'challenge',action})&&['mix','weigh','answer'].includes(action.type))hint('再看看提示，可以慢慢试。');
      return;
    }
    if (l.type === "count") {
      const object = map.objects.find(r => contains(r, point));
      if (object) {
        change({ type: "challenge", action: { type: "countObject", index: object.index } });
        return;
      }
    }
    const item = map.items.find((r) => contains(r, point));
    if (!item) return;
    let action;
    if (["find", "order", "spot"].includes(l.type))
      action = { type: "pick", index: item.index };
    if (["count","pattern"].includes(l.type)) action = { type: "answer", value: item.value };
    if(l.type==="maze")action={type:"move",index:item.index};
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
        parentControl: parentControlAt(point),
        tapArea: tapAreaAt(point),
        maxDistance: 0,
        leftCanvas: false,
        startX: point.x,
        startY: point.y,
        x: point.x,
        y: point.y,
        index: ready ? sourceAt(point) : null,
        moved: false,
        brush: ready&&!parentPanel&&state.scene==='play'&&!model.isComplete(state)&&['trace','clean'].includes(level().type)&&layout().items.some(r=>contains(r,point)),
        brushLast: point,
      };
      if (pointer.index !== null) feedback.removeIndex(pointer.index);
      if(pointer.brush)applyBrush(point,point);
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
      if(pointer.brush){const from=pointer.brushLast;trackPointer(point);pointer.brushLast=point;if(point)applyBrush(from||point,point);draw();return;}
      trackPointer(point);
      draw();
      return;
    }
    if (e.type === "up") {
      trackPointer(point);
      const old = pointer;
      clearPointer();
      if (!point) {
        draw();
        return;
      }
      if(old.brush){applyBrush(old.brushLast||point,point);draw();return;}
      const parentTap=old.parentControl&&!old.leftCanvas&&contains(old.parentControl,point,8)&&old.maxDistance<=16;
      if(parentTap){click(point,old.audioStatus);draw();return;}
      const endArea = tapAreaAt(point);
      const sameArea = old.index !== null ? sourceAt(point) === old.index :
        old.tapArea && endArea && ["x", "y", "w", "h"].every(key => old.tapArea[key] === endArea[key]);
      if (old.index !== null) {
        if (old.moved) {
          const source = layout().items[old.index];
          place(old.index, point, {
            ...source,
            x: point.x - source.w / 2,
            y: point.y - source.h / 2,
          });
        } else if (sameArea) {
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
      } else if (!old.moved && sameArea) click(point, old.audioStatus);
      draw();
    }
  }
  function applyBrush(from,to){
    if(!ready||parentPanel||state.scene!=='play'||model.isComplete(state))return;
    const actions=varietyLayout.pointerActions(level(),state.challenge,layout(),from,to);
    actions.forEach((action,index)=>{
      const quiet=index<actions.length-1||now()-brushFeedbackAt<100;
      if(change({type:'challenge',action},{quiet})&&!quiet)brushFeedbackAt=now();
    });
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
      resetTemporal();
      characterEpoch = now();
      if (state.scene !== "ended") feedback.add("enter", {}, 350);
      if (state.scene === "goodnight") feedback.add("stamp", {}, 1000);
      if (announce) {
        speak();
        if (state.scene === "goodnight" && checkinPlayedFor !== state.day) effect("checkin");
        flushEffects();
      }
      // 当前画面可用后再预取另一套角色，失败留到需要时重试。
      const hero = heroForState(state);
      fetchImage(current === hero.adventure ? hero.bedtime : hero.adventure).catch(() => {});
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
    parentPanel = null;
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
    if (!parentPanel && state.scene === "play" && !model.isComplete(state)) {
      if (level().type === "memory")
        change({ type: "challenge", action: { type: "close" } });
      if (level().type === "sequence")
        change({ type: "challenge", action: { type: "replay" } });
      if (level().type === "hide")change({type:'challenge',action:{type:'replay'}});
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
      hero: {...heroForState(state)},
      voice: currentVoice && {...currentVoice},
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
      parentPanel,
      parentLayout: copy(PARENT_UI),
      parentCanContinue: model.needsParent(state),
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
const legacyV2=require('./legacy-v2');
const legacyV3=require('./legacy-v3');
const RULE_FIELDS={
  find:['target','items'],bridge:['targets','items'],count:['count','icon','choices'],
  sort:['categories','items'],memory:['cards'],sequence:['colors','sequence'],
  order:['icon','sizes'],care:['animal'],
  maze:['cols','rows','blocked','start','end'],puzzle:['picture','cols','rows','pieces'],
  spot:['left','right','differences'],pattern:['cycle','series','answer','choices'],
};
function stableRule(value){
  if(Array.isArray(value))return value.map(stableRule);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableRule(value[key])]));
  return value;
}
function sameRules(previous,current){
  const fields=current&&RULE_FIELDS[current.type];
  return !!previous&&previous.type===current.type&&!!fields&&fields.every(key=>JSON.stringify(stableRule(previous[key]))===JSON.stringify(stableRule(current[key])));
}
function initialState() {
  return {
    v: 4,
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
    return needsParent(s) && (["home", "goodnight", "ended"].includes(s.scene) || (s.scene==='play'&&isComplete(s)))
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
    ![2,3,4].includes(raw.v) ||
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
  let advancedOnUpgrade=false;
  const legacy=raw.v===2?legacyV2:raw.v===3?legacyV3:null;
  const migrating=!!legacy;
  if(migrating&&raw.completed[raw.day]<20&&raw.challenge!=null){
    const previous=legacy[raw.day*20+raw.completed[raw.day]];
    if(challenge.valid(previous,raw.challenge)&&challenge.complete(previous,raw.challenge)){
      raw={...raw,completed:raw.completed.slice(),stamps:raw.stamps.slice()};
      raw.completed[raw.day]++;
      advancedOnUpgrade=true;
      if(raw.completed[raw.day]===20)raw.stamps[raw.day]=validDate(today)?today:localDate();
    }
  }
  const unfinished = raw.completed.findIndex((n) => n < 20);
  if (unfinished >= 0 && raw.day > unfinished) return fresh;
  if (
    raw.day < (unfinished < 0 ? 2 : unfinished) &&
    raw.completed[raw.day] !== 20
  )
    return fresh;
  let c = null;
  if(migrating){
    const l=LEVELS[raw.day*20+Math.min(19,raw.completed[raw.day])];
    const previous=legacy[raw.day*20+Math.min(19,raw.completed[raw.day])];
    c=raw.completed[raw.day]===20?{step:3}:
      !advancedOnUpgrade&&sameRules(previous,l)&&challenge.valid(previous,raw.challenge)&&challenge.valid(l,raw.challenge)
        ?challenge.resume(l,raw.challenge):challenge.initial(l);
  } else if (raw.challenge != null) {
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
    notice: migrating,
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
const STATIONS = [
 ["星光营地","蘑菇溪桥","花谷花园","伙伴小屋"],
 ["贝壳浅滩","热闹码头","月亮灯塔","海湾小屋"],
 ["云朵入口","星球小站","空间营地","晚安星港"],
];
const ORDERS = [
 ["find","bridge","count","maze","puzzle","sort","memory","sequence","spot","order","bridge","count","pattern","find","memory","maze","sort","sequence","order","care"],
 ["puzzle","find","maze","count","spot","sort","memory","bridge","pattern","sequence","order","puzzle","find","sort","bridge","count","memory","sequence","order","care"],
 ["maze","sequence","puzzle","find","pattern","count","memory","sort","spot","bridge","order","find","sequence","memory","count","bridge","sort","maze","order","care"],
];
const TITLES = [
 ["营地亮灯","铺好木桥","给小兔送水果","林间小路","拼出树屋","收拾小营地","谁在树后","萤火虫暗号","花园找不同","给树苗排队","石头过小溪","准备小点心","星星列队","找到小花灯","玩偶好朋友","回家的小径","衣服回小屋","月亮灯密码","摆好小枕头","小兔睡着啦"],
 ["修好小帆船","捡起小贝壳","穿过浅水湾","小鱼来点名","海滩找不同","码头大扫除","海洋好朋友","搭起小栈桥","贝壳花边","灯塔的信号","小船排排队","拼好月亮灯塔","海星捉迷藏","把行李装船","彩色浮桥","分享野餐水果","海风记忆卡","航行指示灯","贝壳从小到大","小熊海边晚安"],
 ["走进云朵城","星球欢迎灯","修好小火箭","收集小星球","宇宙花纹","给飞船补给","太空玩偶配对","整理宇航行李","星空找不同","接通星光桥","火箭发射排队","找回爱心星","空间站密码","云朵记忆盒","点数小卫星","铺好回程桥","太空衣物归位","返回星光卧室","睡前玩偶排队","小恐龙晚安"],
];
const SHAPES=["star","circle","triangle","square","moon","heart"];
const COLORS=["blue","coral","yellow","green"];
const CATEGORY={fruit:["apple","pear","banana"],toy:["ball","block","car"],clothes:["shirt","sock","hat"]};
const SCENE_ICONS=[["flower","apple","tree","rabbit","mushroom","leaf"],["shell","fish","starfish","boat","lighthouse","pear"],["planet","rocket","star","satellite","heart","dino"]];
function shuffled(values,seed){const a=values.slice();let n=seed*7919+17;for(let i=a.length-1;i>0;i--){n=(n*16807)%2147483647;const j=n%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function route(cols,rows,blocked,start,end){const queue=[[start]],seen=new Set([start]);while(queue.length){const path=queue.shift(),cell=path[path.length-1];if(cell===end)return path;for(const next of [cell-cols,cell+cols,cell-1,cell+1]){if(next<0||next>=cols*rows||blocked.includes(next)||seen.has(next)||Math.abs(next%cols-cell%cols)+Math.abs(Math.floor(next/cols)-Math.floor(cell/cols))!==1)continue;seen.add(next);queue.push([...path,next]);}}throw new Error('路线不可达');}
const MAZES=[{cols:3,rows:3,blocked:[4],start:6,end:2},{cols:4,rows:3,blocked:[1,5],start:8,end:3},{cols:4,rows:3,blocked:[2,6,8],start:0,end:11},{cols:4,rows:3,blocked:[1,5,7],start:0,end:3},{cols:4,rows:3,blocked:[4,6,10],start:8,end:0}];
const BRIEFS={find:"找出和目标一样的所有小伙伴。",bridge:"把桥板放进相同图案的空位。",count:"数一数，选择一样多的圆点。",sort:"看篮子图案，把物品分类送回家。",memory:"翻开卡片，找到两个一样的图案。",sequence:"先看彩灯示范，再照着顺序点。",order:"从最小的开始，一个一个点。",care:"放好枕头、盖被子，再关掉灯。",maze:"点相邻的安全格，走到小旗那里。",puzzle:"对照小图，把拼图片放回原位。",spot:"仔细比较，点右边不同的地方。",pattern:"看前面的规律，补上最后一个。"};
const INTRO_ACTIONS={find:"找出同样的图案吧",bridge:"一起把桥板放好吧",count:"数一数准备了几个吧",sort:"把物品分类放好吧",order:"从最小的开始排队吧",maze:"沿安全的小路前进吧",puzzle:"一起把画面拼完整吧"};
const LEVELS=[];let mazeIndex=0;
for(let day=0;day<3;day++){
 const seen={};
 ORDERS[day].forEach((type,index)=>{
  const occurrence=seen[type]||0;seen[type]=occurrence+1;
  const id=day*20+index+1,stationIndex=Math.floor(index/5),pool=SCENE_ICONS[day];
  const l={id,day,index,type,title:TITLES[day][index],theme:DAY_THEMES[day],stationIndex,station:STATIONS[day][stationIndex],brief:BRIEFS[type],voice:type};
  const shift=day*2+occurrence;
  if(type==='find'){
   l.target=day===0?(occurrence===0?'star':'flower'):pool[occurrence*2];
   const other=pool.filter(x=>x!==l.target);
   l.items=shuffled([...Array(3+day).fill(l.target),...Array.from({length:day+1},(_,i)=>other[(i+shift)%other.length])],id);
  }
  if(type==='bridge'){l.targets=Array.from({length:3+day},(_,i)=>SHAPES[(i+shift)%6]);l.items=shuffled(l.targets,id+4);}
  if(type==='count'){l.count=2+day+occurrence;l.icon=[['apple','banana'],['fish','pear'],['planet','satellite']][day][occurrence];l.choices=shuffled([l.count,...shuffled([1,2,3,4,5,6].filter(n=>n!==l.count),id).slice(0,2)],id+20);}
  if(type==='sort'){l.categories=day===0?(occurrence?['clothes','toy']:['fruit','toy']):day===1?(occurrence?['clothes','toy']:['fruit','toy','clothes']):['fruit','toy','clothes'];l.items=shuffled(Array.from({length:4+day},(_,i)=>{const category=l.categories[i%l.categories.length];return {category,icon:CATEGORY[category][(Math.floor(i/l.categories.length)+occurrence+day)%3]};}),id);}
  if(type==='memory'){const pairs=day===0?2:day===1?3:3+occurrence;const symbols=Array.from({length:pairs},(_,i)=>pool[(i+shift)%pool.length]);l.cards=shuffled([...symbols,...symbols],id);}
  if(type==='sequence'){const sequences=[[[0,1],[2,0]],[[0,3,2],[1,0,3]],[[3,0,1],[0,2,3,1]]];l.colors=COLORS;l.sequence=sequences[day][occurrence].map(i=>COLORS[i]);}
  if(type==='order'){l.icon=[['tree','pillow'],['boat','shell'],['rocket','bear']][day][occurrence];l.sizes=shuffled(day===2?[24,34,44,54]:[28,42,56],id);}
  if(type==='care'){l.animal=['rabbit','bear','dino'][day];l.voice='pillow';}
  if(type==='maze'){Object.assign(l,MAZES[mazeIndex++]);l.solution=route(l.cols,l.rows,l.blocked,l.start,l.end);l.companion=['rabbit','bear','dino'][day];}
  if(type==='puzzle'){l.picture=day===0?'treehouse':day===1?(occurrence?'lighthouse':'boat'):'rocket';l.cols=day===2?3:2;l.rows=2;l.pieces=shuffled(Array.from({length:l.cols*l.rows},(_,i)=>i),id);}
  if(type==='spot'){l.left=pool.slice(0,day===0?4:6);l.right=l.left.slice();l.differences=shuffled(l.left.map((_,i)=>i),id).slice(0,day===0?1:2);l.differences.forEach((i,k)=>{l.right[i]=pool[(i+1+k)%pool.length];if(l.right[i]===l.left[i])l.right[i]='heart';});}
  if(type==='pattern'){l.cycle=[['star','moon'],['shell','shell','fish'],['planet','star','rocket']][day];l.series=Array.from({length:day===0?4:5},(_,i)=>l.cycle[i%l.cycle.length]);l.answer=l.cycle[l.series.length%l.cycle.length];l.choices=shuffled([l.answer,...pool.filter(x=>x!==l.answer).slice(0,2)],id);}
  if(index%5===0){l.voice=`intro-${day+1}-${stationIndex+1}`;l.introText=`来到${l.station}，${INTRO_ACTIONS[type]}！`;}
  LEVELS.push(l);
 });
}
// 将每组重复的一轮替换为不同操作方式，未替换关卡的规则和编号保持稳定。
const VARIETY_TASKS = [
 [2,'trace','连出星星小桥'],[4,'share','小兔的分享点心'],[7,'rotate','扶正树屋路牌'],[10,'hide','谁躲进了花丛'],
 [12,'clean','擦亮点心橱窗'],[14,'mix','调一盏橙色小灯'],[17,'balance','小屋里的天平'],[18,'listen','听听谁在门外'],
 [21,'mix','调出海湾的绿色'],[27,'listen','码头是谁在叫'],[28,'hide','海风藏起了谁'],[30,'share','海边分享小点心'],
 [33,'clean','擦亮灯塔的窗'],[34,'rotate','扶正航海图'],[36,'trace','连出回家的星路'],[39,'balance','小船装货一样重'],
 [42,'rotate','转正太空路标'],[46,'share','分享星球小点心'],[48,'hide','谁躲到云朵后'],[51,'trace','连亮火箭航线'],
 [52,'balance','空间站称一称'],[54,'listen','星空里谁在叫'],[56,'clean','擦亮星港舷窗'],[58,'mix','调出紫色星光'],
];
const VARIETY_BRIEFS={trace:'从亮着的星星开始，按顺序连起来。',clean:'擦一擦白雾，看看窗外藏着什么。',mix:'选两种颜料，调出和目标一样的颜色。',rotate:'点一点图案，把它们转正。',share:'给每位伙伴一份点心，不多也不少。',balance:'添上或取回砝码，让两边一样重。',listen:'点喇叭听一听，找到正在叫的伙伴。',hide:'先记住伙伴，再找出躲起来的那一个。'};
const VARIETY_INTROS={trace:'按顺序连亮星星吧',clean:'擦亮窗户看看风景吧',mix:'一起调出目标颜色吧',share:'给每位伙伴分一份点心吧'};
for(const [id,type,title] of VARIETY_TASKS){
 const old=LEVELS[id-1],day=old.day,pool=SCENE_ICONS[day];
 const l={id,day,index:old.index,type,title,theme:old.theme,stationIndex:old.stationIndex,station:old.station,brief:VARIETY_BRIEFS[type],voice:type};
 if(type==='trace')l.points=[[[.08,.75],[.32,.42],[.60,.55],[.90,.18]],[[.08,.20],[.28,.62],[.50,.25],[.73,.70],[.92,.30]],[[.08,.72],[.27,.35],[.48,.65],[.70,.25],[.92,.50]]][day];
 if(type==='clean'){l.picture=['treehouse','lighthouse','rocket'][day];l.patches=day===2?12:9;}
 if(type==='mix'){l.colors=['red','yellow','blue'];l.recipe=[['red','yellow'],['yellow','blue'],['red','blue']][day];l.targetColor=['orange','green','purple'][day];}
 if(type==='rotate'){l.icons=[['tree','rabbit','car'],['boat','lighthouse','car'],['rocket','satellite','dino']][day];l.rotations=[[1,3,2],[2,1,3],[3,2,1]][day];}
 if(type==='share'){l.recipients=day===0?['rabbit','bear']:day===1?['bear','rabbit','dino']:['dino','bear','rabbit'];l.gifts=Array(l.recipients.length).fill(['apple','pear','banana'][day]);}
 if(type==='balance'){l.target=3+day;l.weights=[1,2];}
 if(type==='listen'){l.answer=['cat','dog','duck'][day];l.choices=shuffled(['cat','dog','duck'],id);l.voice='listen-'+l.answer;}
 if(type==='hide'){l.shown=pool.slice(0,day===0?3:4);l.hiddenIndex=day%l.shown.length;const answer=l.shown[l.hiddenIndex];l.choices=shuffled([answer,...pool.filter(x=>x!==answer).slice(0,2)],id);}
 if(l.index%5===0){l.voice=`intro-${day+1}-${l.stationIndex+1}`;l.introText=`来到${l.station}，${VARIETY_INTROS[type]}！`;}
 LEVELS[id-1]=l;
}
module.exports={LEVELS,DAY_THEMES,STATIONS,SHAPES,COLORS,CATEGORY,shuffled,route};

},
"src/challenges.js":function(require,module,exports){
const variety=require('./variety-challenges');
function initial(l) {
  if(variety.isVariety(l.type))return variety.initial(l);
  if (l.type === "find" || l.type === "spot") return { found: [] };
  if (["bridge","sort","puzzle"].includes(l.type)) return { placed: [] };
  if (l.type === "count" || l.type === "pattern") return { solved: false };
  if (l.type === "maze") return { cell:l.start, trail:[l.start], done:false };
  if (l.type === "memory") return { matched: [], open: [] };
  if (l.type === "sequence") return { step: 0, mode: "demo" };
  if (l.type === "order") return { picked: [] };
  return { step: 0 };
}
function goal(l) {
  if(variety.isVariety(l.type))return variety.goal(l);
  if (l.type === "find") return l.items.filter((x) => x === l.target).length;
  if (l.type === "spot") return l.differences.length;
  if (l.type === "puzzle") return l.pieces.length;
  if (["bridge", "sort"].includes(l.type)) return l.items.length;
  if (l.type === "memory") return l.cards.length / 2;
  if (l.type === "sequence") return l.sequence.length;
  if (l.type === "order") return l.sizes.length;
  if (l.type === "care") return 3;
  return 1;
}
function progress(l, c) {
  if(variety.isVariety(l.type))return variety.progress(l,c);
  if (!c) return 0;
  if (l.type === "find" || l.type === "spot") return c.found.length;
  if (["bridge", "sort", "puzzle"].includes(l.type)) return c.placed.length;
  if (l.type === "maze") return c.done ? 1 : 0;
  if (l.type === "memory") return c.matched.length / 2;
  if (l.type === "sequence" || l.type === "care") return c.step;
  if (l.type === "order") return c.picked.length;
  return c.solved ? 1 : 0;
}
function complete(l, c) {
  return progress(l, c) === goal(l);
}
function update(l, c, a) {
  if(variety.isVariety(l.type))return variety.update(l,c,a);
  if (complete(l, c)) return c;
  const index = a.index,
    hasIndex = Number.isInteger(index) && index >= 0;
  if(l.type==='maze'&&a.type==='move'&&hasIndex&&index<l.cols*l.rows&&!l.blocked.includes(index)&&adjacent(l,c.cell,index)){
    const previous=c.trail.indexOf(index),trail=previous>=0?c.trail.slice(0,previous+1):[...c.trail,index];
    return {cell:index,trail,done:index===l.end};
  }
  if(l.type==='puzzle'&&a.type==='place'&&hasIndex&&index<l.pieces.length&&!c.placed.includes(index)&&a.target===l.pieces[index])return {placed:[...c.placed,index]};
  if(l.type==='spot'&&a.type==='pick'&&hasIndex&&l.differences.includes(index)&&!c.found.includes(index))return {found:[...c.found,index]};
  if(l.type==='pattern'&&a.type==='answer'&&a.value===l.answer)return {solved:true};
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
  if (l.type === "count" && a.type === "countObject" && hasIndex && index < l.count && !(c.counted || []).includes(index))
    return { ...c, counted: [...(c.counted || []), index] };
  if (l.type === "count" && a.type === "answer" && a.value === l.count)
    return { ...c, solved: true };
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
  if(variety.isVariety(l.type))return variety.valid(l,c);
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const list = (a, max) =>
    Array.isArray(a) &&
    new Set(a).size === a.length &&
    a.every((i) => Number.isInteger(i) && i >= 0 && i < max);
  if(l.type==='maze')return list(c.trail,l.cols*l.rows)&&c.trail.length>0&&c.trail[0]===l.start&&c.trail[c.trail.length-1]===c.cell&&c.trail.every((cell,i)=>!l.blocked.includes(cell)&&(i===0||adjacent(l,c.trail[i-1],cell)))&&typeof c.done==='boolean'&&c.done===(c.cell===l.end);
  if(l.type==='puzzle')return list(c.placed,l.pieces.length);
  if(l.type==='spot')return list(c.found,l.right.length)&&c.found.every(i=>l.differences.includes(i));
  if(l.type==='pattern')return typeof c.solved==='boolean';
  if (l.type === "find")
    return (
      list(c.found, l.items.length) &&
      c.found.every((i) => l.items[i] === l.target)
    );
  if (["bridge", "sort"].includes(l.type))
    return list(c.placed, l.items.length);
  if (l.type === "count") return typeof c.solved === "boolean" &&
    (c.counted === undefined || list(c.counted, l.count));
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
  if(variety.isVariety(l.type))return variety.resume(l,c);
  if (!valid(l, c)) return initial(l);
  const copy = JSON.parse(JSON.stringify(c));
  if (l.type === "memory") copy.open = [];
  if (l.type === "sequence" && !complete(l, copy)) return initial(l);
  return copy;
}
function instruction(l, c) {
  if(variety.isVariety(l.type))return variety.instruction(l,c);
  if (complete(l, c))
    return l.type === "care"
      ? "伙伴睡着啦，本组的冒险完成了！"
      : "完成啦！一起去下一关吧。";
  const texts = {
    find: "找到和上面图案一样的所有图形吧！",
    bridge: "把桥板放到相同图案的位置吧！",
    count: "可以点一点图案数数，再选一样多的圆点吧！",
    sort: "把物件送回同一类的篮子吧！",
    memory: "翻开卡片，找到相同的两个图案吧！",
    sequence:
      c.mode === "demo"
        ? "看清彩灯亮起的顺序，再照着点一遍。"
        : "轮到你啦，按刚才的顺序点彩灯吧！",
    order: "找一找，从最小的开始依次点一下吧！",
  };
  if(['maze','puzzle','spot','pattern'].includes(l.type))return l.brief;
  return l.type === "care"
    ? [
        "先把枕头放到伙伴头下吧！",
        "再给伙伴盖上柔软的小被子吧！",
        "最后，轻轻关掉小灯吧！",
      ][c.step]
    : texts[l.type];
}
function adjacent(l,a,b){return Math.abs(a%l.cols-b%l.cols)+Math.abs(Math.floor(a/l.cols)-Math.floor(b/l.cols))===1;}
function mazeHint(l,c){
  const queue=[[c.cell]],seen=new Set([c.cell]);
  while(queue.length){const route=queue.shift(),cell=route[route.length-1];if(cell===l.end)return route[1]??cell;for(const next of [cell-1,cell+1,cell-l.cols,cell+l.cols]){if(next<0||next>=l.cols*l.rows||l.blocked.includes(next)||seen.has(next)||!adjacent(l,cell,next))continue;seen.add(next);queue.push([...route,next]);}}
  return c.cell;
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
  mazeHint,
};

},
"src/variety-challenges.js":function(require,module,exports){
const TYPES=new Set(['trace','clean','mix','rotate','share','balance','listen','hide']);
const isVariety=type=>TYPES.has(type);
const sum=values=>values.reduce((a,b)=>a+b,0);
const sameColors=(a,b)=>a.length===b.length&&a.every(value=>b.includes(value));
function initial(l){
 if(l.type==='trace')return {reached:0};
 if(l.type==='clean')return {cleared:[]};
 if(l.type==='mix')return {selected:[],solved:false};
 if(l.type==='rotate')return {turns:l.rotations.slice()};
 if(l.type==='share')return {given:[]};
 if(l.type==='balance')return {added:[],solved:false};
 if(l.type==='listen')return {solved:false};
 if(l.type==='hide')return {mode:'preview',solved:false};
 return null;
}
function goal(l){
 if(l.type==='trace')return l.points.length;
 if(l.type==='clean')return l.patches;
 if(l.type==='rotate')return l.icons.length;
 if(l.type==='share')return l.gifts.length;
 return 1;
}
function progress(l,c){
 if(!c)return 0;
 if(l.type==='trace')return c.reached;
 if(l.type==='clean')return c.cleared.length;
 if(l.type==='rotate')return c.turns.filter(turn=>turn===0).length;
 if(l.type==='share')return c.given.length;
 return c.solved?1:0;
}
function complete(l,c){return !!c&&progress(l,c)===goal(l);}
function update(l,c,a){
 if(!c||!a||complete(l,c))return c;
 const index=a.index,validIndex=Number.isInteger(index)&&index>=0;
 if(l.type==='trace'&&a.type==='trace'&&validIndex&&index===c.reached&&index<l.points.length)return {reached:c.reached+1};
 if(l.type==='clean'&&a.type==='wipe'&&validIndex&&index<l.patches&&!c.cleared.includes(index))return {cleared:[...c.cleared,index]};
 if(l.type==='mix'){
  if(a.type==='color'&&l.colors.includes(a.value)&&c.selected.length<2&&!c.selected.includes(a.value))return {...c,selected:[...c.selected,a.value]};
  if(a.type==='clear'&&c.selected.length)return {selected:[],solved:false};
  if(a.type==='mix'&&sameColors(c.selected,l.recipe))return {...c,solved:true};
 }
 if(l.type==='rotate'&&a.type==='rotate'&&validIndex&&index<c.turns.length&&c.turns[index]!==0){const turns=c.turns.slice();turns[index]=(turns[index]+1)%4;return {turns};}
 if(l.type==='share'&&a.type==='give'&&validIndex&&index<l.gifts.length&&Number.isInteger(a.target)&&a.target>=0&&a.target<l.recipients.length&&!c.given.some(x=>x.index===index||x.target===a.target))return {given:[...c.given,{index,target:a.target}]};
 if(l.type==='balance'){
  if(a.type==='add'&&l.weights.includes(a.value)&&sum(c.added)+a.value<=l.target+3)return {...c,added:[...c.added,a.value]};
  if(a.type==='undo'&&c.added.length)return {...c,added:c.added.slice(0,-1)};
  if(a.type==='weigh'&&sum(c.added)===l.target)return {...c,solved:true};
 }
 if(l.type==='listen'&&a.type==='answer'&&a.value===l.answer)return {solved:true};
 if(l.type==='hide'){
  if(a.type==='previewDone'&&c.mode==='preview')return {mode:'choose',solved:false};
  if(a.type==='replay')return {mode:'preview',solved:false};
  if(a.type==='answer'&&c.mode==='choose'&&a.value===l.shown[l.hiddenIndex])return {mode:'choose',solved:true};
 }
 return c;
}
function uniqueIndices(values,max){return Array.isArray(values)&&new Set(values).size===values.length&&values.every(x=>Number.isInteger(x)&&x>=0&&x<max);}
function valid(l,c){
 if(!c||typeof c!=='object'||Array.isArray(c))return false;
 if(l.type==='trace')return Number.isInteger(c.reached)&&c.reached>=0&&c.reached<=l.points.length;
 if(l.type==='clean')return uniqueIndices(c.cleared,l.patches);
 if(l.type==='mix')return Array.isArray(c.selected)&&c.selected.length<=2&&new Set(c.selected).size===c.selected.length&&c.selected.every(x=>l.colors.includes(x))&&typeof c.solved==='boolean'&&(!c.solved||sameColors(c.selected,l.recipe));
 if(l.type==='rotate')return Array.isArray(c.turns)&&c.turns.length===l.icons.length&&c.turns.every(x=>Number.isInteger(x)&&x>=0&&x<4);
 if(l.type==='share')return Array.isArray(c.given)&&c.given.every(x=>x&&typeof x==='object')&&uniqueIndices(c.given.map(x=>x.index),l.gifts.length)&&uniqueIndices(c.given.map(x=>x.target),l.recipients.length);
 if(l.type==='balance')return Array.isArray(c.added)&&c.added.every(x=>l.weights.includes(x))&&sum(c.added)<=l.target+3&&typeof c.solved==='boolean'&&(!c.solved||sum(c.added)===l.target);
 if(l.type==='listen')return typeof c.solved==='boolean';
 if(l.type==='hide')return ['preview','choose'].includes(c.mode)&&typeof c.solved==='boolean'&&(!c.solved||c.mode==='choose');
 return false;
}
function resume(l,c){
 if(!valid(l,c))return initial(l);
 if(l.type==='hide'&&!c.solved)return initial(l);
 return JSON.parse(JSON.stringify(c));
}
function instruction(l,c){
 if(complete(l,c))return '完成啦！一起去下一关吧。';
 const text={trace:'从亮星星开始，按顺序点亮或连起来吧。',clean:'用手指擦一擦白雾，看看里面藏着什么。',mix:'选两种颜料，调成右边的颜色，再点调色。',rotate:'点一点图案，把它们转正吧。',share:'每位伙伴分一份，拖过去或点选再放下吧。',balance:'给右边加砝码，一样重后点称好了。',listen:'点喇叭听一听，选出正在叫的小动物。',hide:c&&c.mode==='preview'?'先记住这些伙伴，看看一会儿谁躲起来。':'谁躲起来了？从下面找出来吧。'};
 return text[l.type]||'';
}
module.exports={isVariety,initial,goal,progress,complete,update,valid,resume,instruction};

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
"src/legacy-v2.js":function(require,module,exports){
// 仅用于V2迁移：核实旧当前关是否已完成，防止重复要求通关。
module.exports = [{"type":"find","target":"star","items":["star","circle","star","star"]},{"type":"bridge","targets":["star","circle","triangle"],"items":["star","circle","triangle"]},{"type":"count","count":1,"icon":"star","choices":[2,1,6]},{"type":"sort","categories":["fruit","toy"],"items":[{"category":"toy","icon":"ball"},{"category":"fruit","icon":"pear"},{"category":"fruit","icon":"apple"},{"category":"toy","icon":"block"}]},{"type":"memory","cards":["circle","star","circle","star"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["blue","coral"]},{"type":"order","icon":"star","sizes":[28,56,42]},{"type":"find","target":"triangle","items":["triangle","triangle","triangle","circle"]},{"type":"bridge","targets":["circle","triangle","square"],"items":["circle","square","triangle"]},{"type":"count","count":2,"icon":"triangle","choices":[4,2,5]},{"type":"sort","categories":["fruit","clothes"],"items":[{"category":"clothes","icon":"sock"},{"category":"clothes","icon":"hat"},{"category":"fruit","icon":"pear"},{"category":"fruit","icon":"banana"}]},{"type":"memory","cards":["circle","circle","triangle","triangle"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["yellow","blue"]},{"type":"order","icon":"square","sizes":[42,56,28]},{"type":"find","target":"moon","items":["triangle","moon","moon","moon"]},{"type":"count","count":3,"icon":"moon","choices":[5,1,3]},{"type":"sort","categories":["fruit","toy"],"items":[{"category":"toy","icon":"ball"},{"category":"fruit","icon":"banana"},{"category":"fruit","icon":"apple"},{"category":"toy","icon":"car"}]},{"type":"memory","cards":["triangle","square","square","triangle"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["green","coral"]},{"type":"care","animal":"rabbit"},{"type":"find","target":"circle","items":["circle","circle","square","moon","circle","circle"]},{"type":"bridge","targets":["triangle","square","moon","heart"],"items":["square","triangle","heart","moon"]},{"type":"count","count":2,"icon":"circle","choices":[2,5,1]},{"type":"sort","categories":["toy","clothes"],"items":[{"category":"clothes","icon":"hat"},{"category":"clothes","icon":"sock"},{"category":"toy","icon":"block"},{"category":"toy","icon":"car"},{"category":"toy","icon":"ball"}]},{"type":"memory","cards":["square","square","triangle","moon","moon","triangle"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["blue","green","yellow"]},{"type":"order","icon":"circle","sizes":[56,28,42]},{"type":"find","target":"square","items":["square","square","moon","square","heart","square"]},{"type":"bridge","targets":["square","moon","heart","star"],"items":["moon","star","square","heart"]},{"type":"count","count":3,"icon":"square","choices":[2,1,3]},{"type":"sort","categories":["fruit","toy","clothes"],"items":[{"category":"toy","icon":"ball"},{"category":"toy","icon":"car"},{"category":"clothes","icon":"hat"},{"category":"fruit","icon":"apple"},{"category":"fruit","icon":"banana"}]},{"type":"memory","cards":["moon","square","square","moon","heart","heart"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["coral","blue","green"]},{"type":"order","icon":"moon","sizes":[28,42,56]},{"type":"find","target":"heart","items":["star","heart","heart","heart","heart","moon"]},{"type":"count","count":4,"icon":"heart","choices":[2,1,4]},{"type":"sort","categories":["fruit","toy","clothes"],"items":[{"category":"fruit","icon":"apple"},{"category":"clothes","icon":"shirt"},{"category":"toy","icon":"block"},{"category":"fruit","icon":"pear"},{"category":"toy","icon":"ball"}]},{"type":"memory","cards":["star","moon","heart","star","moon","heart"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["yellow","coral","blue"]},{"type":"care","animal":"bear"},{"type":"find","target":"triangle","items":["triangle","star","circle","triangle","triangle","triangle","heart","triangle"]},{"type":"bridge","targets":["moon","heart","star","circle","triangle"],"items":["star","moon","triangle","heart","circle"]},{"type":"count","count":3,"icon":"triangle","choices":[4,3,2]},{"type":"sort","categories":["fruit","toy","clothes"],"items":[{"category":"clothes","icon":"hat"},{"category":"fruit","icon":"banana"},{"category":"fruit","icon":"apple"},{"category":"clothes","icon":"shirt"},{"category":"toy","icon":"ball"},{"category":"toy","icon":"car"}]},{"type":"memory","cards":["star","heart","moon","star","heart","moon"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["green","blue","coral"]},{"type":"order","icon":"triangle","sizes":[54,44,34,24]},{"type":"find","target":"moon","items":["moon","moon","triangle","moon","star","circle","moon","moon"]},{"type":"bridge","targets":["heart","star","circle","triangle","square"],"items":["triangle","square","heart","star","circle"]},{"type":"count","count":4,"icon":"moon","choices":[2,1,4]},{"type":"sort","categories":["fruit","toy","clothes"],"items":[{"category":"toy","icon":"block"},{"category":"toy","icon":"ball"},{"category":"fruit","icon":"pear"},{"category":"fruit","icon":"apple"},{"category":"clothes","icon":"shirt"},{"category":"clothes","icon":"sock"}]},{"type":"memory","cards":["heart","star","star","heart","circle","triangle","triangle","circle"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["blue","yellow","green","coral"]},{"type":"order","icon":"heart","sizes":[44,54,34,24]},{"type":"find","target":"star","items":["square","star","triangle","star","moon","star","star","star"]},{"type":"count","count":5,"icon":"star","choices":[3,1,5]},{"type":"sort","categories":["fruit","toy","clothes"],"items":[{"category":"clothes","icon":"sock"},{"category":"toy","icon":"block"},{"category":"toy","icon":"car"},{"category":"fruit","icon":"pear"},{"category":"fruit","icon":"banana"},{"category":"clothes","icon":"hat"}]},{"type":"memory","cards":["circle","square","triangle","square","circle","triangle","star","star"]},{"type":"sequence","colors":["blue","coral","yellow","green"],"sequence":["coral","green","yellow","blue"]},{"type":"care","animal":"dino"}];

},
"src/legacy-v3.js":function(require,module,exports){
module.exports = [
  {
    "id": 1,
    "day": 0,
    "index": 0,
    "type": "find",
    "title": "营地亮灯",
    "theme": "星光森林",
    "stationIndex": 0,
    "station": "星光营地",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "intro-1-1",
    "target": "star",
    "items": [
      "star",
      "flower",
      "star",
      "star"
    ],
    "introText": "来到星光营地，找出同样的图案吧！"
  },
  {
    "id": 2,
    "day": 0,
    "index": 1,
    "type": "bridge",
    "title": "铺好木桥",
    "theme": "星光森林",
    "stationIndex": 0,
    "station": "星光营地",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "bridge",
    "targets": [
      "star",
      "circle",
      "triangle"
    ],
    "items": [
      "star",
      "circle",
      "triangle"
    ]
  },
  {
    "id": 3,
    "day": 0,
    "index": 2,
    "type": "count",
    "title": "给小兔送水果",
    "theme": "星光森林",
    "stationIndex": 0,
    "station": "星光营地",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "count",
    "count": 2,
    "icon": "apple",
    "choices": [
      1,
      2,
      6
    ]
  },
  {
    "id": 4,
    "day": 0,
    "index": 3,
    "type": "maze",
    "title": "林间小路",
    "theme": "星光森林",
    "stationIndex": 0,
    "station": "星光营地",
    "brief": "点相邻的安全格，走到小旗那里。",
    "voice": "maze",
    "cols": 3,
    "rows": 3,
    "blocked": [
      4
    ],
    "start": 6,
    "end": 2,
    "solution": [
      6,
      3,
      0,
      1,
      2
    ],
    "companion": "rabbit"
  },
  {
    "id": 5,
    "day": 0,
    "index": 4,
    "type": "puzzle",
    "title": "拼出树屋",
    "theme": "星光森林",
    "stationIndex": 0,
    "station": "星光营地",
    "brief": "对照小图，把拼图片放回原位。",
    "voice": "puzzle",
    "picture": "treehouse",
    "cols": 2,
    "rows": 2,
    "pieces": [
      3,
      2,
      1,
      0
    ]
  },
  {
    "id": 6,
    "day": 0,
    "index": 5,
    "type": "sort",
    "title": "收拾小营地",
    "theme": "星光森林",
    "stationIndex": 1,
    "station": "蘑菇溪桥",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "intro-1-2",
    "categories": [
      "fruit",
      "toy"
    ],
    "items": [
      {
        "category": "fruit",
        "icon": "apple"
      },
      {
        "category": "toy",
        "icon": "block"
      },
      {
        "category": "fruit",
        "icon": "pear"
      },
      {
        "category": "toy",
        "icon": "ball"
      }
    ],
    "introText": "来到蘑菇溪桥，把物品分类放好吧！"
  },
  {
    "id": 7,
    "day": 0,
    "index": 6,
    "type": "memory",
    "title": "谁在树后",
    "theme": "星光森林",
    "stationIndex": 1,
    "station": "蘑菇溪桥",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "apple",
      "flower",
      "apple",
      "flower"
    ]
  },
  {
    "id": 8,
    "day": 0,
    "index": 7,
    "type": "sequence",
    "title": "萤火虫暗号",
    "theme": "星光森林",
    "stationIndex": 1,
    "station": "蘑菇溪桥",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "blue",
      "coral"
    ]
  },
  {
    "id": 9,
    "day": 0,
    "index": 8,
    "type": "spot",
    "title": "花园找不同",
    "theme": "星光森林",
    "stationIndex": 1,
    "station": "蘑菇溪桥",
    "brief": "仔细比较，点右边不同的地方。",
    "voice": "spot",
    "left": [
      "flower",
      "apple",
      "tree",
      "rabbit"
    ],
    "right": [
      "flower",
      "apple",
      "rabbit",
      "rabbit"
    ],
    "differences": [
      2
    ]
  },
  {
    "id": 10,
    "day": 0,
    "index": 9,
    "type": "order",
    "title": "给树苗排队",
    "theme": "星光森林",
    "stationIndex": 1,
    "station": "蘑菇溪桥",
    "brief": "从最小的开始，一个一个点。",
    "voice": "order",
    "icon": "tree",
    "sizes": [
      28,
      56,
      42
    ]
  },
  {
    "id": 11,
    "day": 0,
    "index": 10,
    "type": "bridge",
    "title": "石头过小溪",
    "theme": "星光森林",
    "stationIndex": 2,
    "station": "花谷花园",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "intro-1-3",
    "targets": [
      "circle",
      "triangle",
      "square"
    ],
    "items": [
      "triangle",
      "circle",
      "square"
    ],
    "introText": "来到花谷花园，一起把桥板放好吧！"
  },
  {
    "id": 12,
    "day": 0,
    "index": 11,
    "type": "count",
    "title": "准备小点心",
    "theme": "星光森林",
    "stationIndex": 2,
    "station": "花谷花园",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "count",
    "count": 3,
    "icon": "banana",
    "choices": [
      3,
      2,
      6
    ]
  },
  {
    "id": 13,
    "day": 0,
    "index": 12,
    "type": "pattern",
    "title": "星星列队",
    "theme": "星光森林",
    "stationIndex": 2,
    "station": "花谷花园",
    "brief": "看前面的规律，补上最后一个。",
    "voice": "pattern",
    "cycle": [
      "star",
      "moon"
    ],
    "series": [
      "star",
      "moon",
      "star",
      "moon"
    ],
    "answer": "star",
    "choices": [
      "star",
      "apple",
      "flower"
    ]
  },
  {
    "id": 14,
    "day": 0,
    "index": 13,
    "type": "find",
    "title": "找到小花灯",
    "theme": "星光森林",
    "stationIndex": 2,
    "station": "花谷花园",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "find",
    "target": "flower",
    "items": [
      "flower",
      "flower",
      "tree",
      "flower"
    ]
  },
  {
    "id": 15,
    "day": 0,
    "index": 14,
    "type": "memory",
    "title": "玩偶好朋友",
    "theme": "星光森林",
    "stationIndex": 2,
    "station": "花谷花园",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "tree",
      "tree",
      "apple",
      "apple"
    ]
  },
  {
    "id": 16,
    "day": 0,
    "index": 15,
    "type": "maze",
    "title": "回家的小径",
    "theme": "星光森林",
    "stationIndex": 3,
    "station": "伙伴小屋",
    "brief": "点相邻的安全格，走到小旗那里。",
    "voice": "intro-1-4",
    "cols": 4,
    "rows": 3,
    "blocked": [
      1,
      5
    ],
    "start": 8,
    "end": 3,
    "solution": [
      8,
      9,
      10,
      6,
      2,
      3
    ],
    "companion": "rabbit",
    "introText": "来到伙伴小屋，沿安全的小路前进吧！"
  },
  {
    "id": 17,
    "day": 0,
    "index": 16,
    "type": "sort",
    "title": "衣服回小屋",
    "theme": "星光森林",
    "stationIndex": 3,
    "station": "伙伴小屋",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "sort",
    "categories": [
      "clothes",
      "toy"
    ],
    "items": [
      {
        "category": "toy",
        "icon": "car"
      },
      {
        "category": "clothes",
        "icon": "sock"
      },
      {
        "category": "clothes",
        "icon": "hat"
      },
      {
        "category": "toy",
        "icon": "block"
      }
    ]
  },
  {
    "id": 18,
    "day": 0,
    "index": 17,
    "type": "sequence",
    "title": "月亮灯密码",
    "theme": "星光森林",
    "stationIndex": 3,
    "station": "伙伴小屋",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "yellow",
      "blue"
    ]
  },
  {
    "id": 19,
    "day": 0,
    "index": 18,
    "type": "order",
    "title": "摆好小枕头",
    "theme": "星光森林",
    "stationIndex": 3,
    "station": "伙伴小屋",
    "brief": "从最小的开始，一个一个点。",
    "voice": "order",
    "icon": "pillow",
    "sizes": [
      56,
      42,
      28
    ]
  },
  {
    "id": 20,
    "day": 0,
    "index": 19,
    "type": "care",
    "title": "小兔睡着啦",
    "theme": "星光森林",
    "stationIndex": 3,
    "station": "伙伴小屋",
    "brief": "放好枕头、盖被子，再关掉灯。",
    "voice": "pillow",
    "animal": "rabbit"
  },
  {
    "id": 21,
    "day": 1,
    "index": 0,
    "type": "puzzle",
    "title": "修好小帆船",
    "theme": "月亮海湾",
    "stationIndex": 0,
    "station": "贝壳浅滩",
    "brief": "对照小图，把拼图片放回原位。",
    "voice": "intro-2-1",
    "picture": "boat",
    "cols": 2,
    "rows": 2,
    "pieces": [
      0,
      3,
      2,
      1
    ],
    "introText": "来到贝壳浅滩，一起把画面拼完整吧！"
  },
  {
    "id": 22,
    "day": 1,
    "index": 1,
    "type": "find",
    "title": "捡起小贝壳",
    "theme": "月亮海湾",
    "stationIndex": 0,
    "station": "贝壳浅滩",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "find",
    "target": "shell",
    "items": [
      "shell",
      "lighthouse",
      "shell",
      "shell",
      "boat",
      "shell"
    ]
  },
  {
    "id": 23,
    "day": 1,
    "index": 2,
    "type": "maze",
    "title": "穿过浅水湾",
    "theme": "月亮海湾",
    "stationIndex": 0,
    "station": "贝壳浅滩",
    "brief": "点相邻的安全格，走到小旗那里。",
    "voice": "maze",
    "cols": 4,
    "rows": 3,
    "blocked": [
      2,
      6,
      8
    ],
    "start": 0,
    "end": 11,
    "solution": [
      0,
      4,
      5,
      9,
      10,
      11
    ],
    "companion": "bear"
  },
  {
    "id": 24,
    "day": 1,
    "index": 3,
    "type": "count",
    "title": "小鱼来点名",
    "theme": "月亮海湾",
    "stationIndex": 0,
    "station": "贝壳浅滩",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "count",
    "count": 3,
    "icon": "fish",
    "choices": [
      3,
      2,
      5
    ]
  },
  {
    "id": 25,
    "day": 1,
    "index": 4,
    "type": "spot",
    "title": "海滩找不同",
    "theme": "月亮海湾",
    "stationIndex": 0,
    "station": "贝壳浅滩",
    "brief": "仔细比较，点右边不同的地方。",
    "voice": "spot",
    "left": [
      "shell",
      "fish",
      "starfish",
      "boat",
      "lighthouse",
      "pear"
    ],
    "right": [
      "shell",
      "boat",
      "starfish",
      "boat",
      "pear",
      "pear"
    ],
    "differences": [
      4,
      1
    ]
  },
  {
    "id": 26,
    "day": 1,
    "index": 5,
    "type": "sort",
    "title": "码头大扫除",
    "theme": "月亮海湾",
    "stationIndex": 1,
    "station": "热闹码头",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "intro-2-2",
    "categories": [
      "fruit",
      "toy",
      "clothes"
    ],
    "items": [
      {
        "category": "fruit",
        "icon": "banana"
      },
      {
        "category": "toy",
        "icon": "block"
      },
      {
        "category": "clothes",
        "icon": "sock"
      },
      {
        "category": "toy",
        "icon": "car"
      },
      {
        "category": "fruit",
        "icon": "pear"
      }
    ],
    "introText": "来到热闹码头，把物品分类放好吧！"
  },
  {
    "id": 27,
    "day": 1,
    "index": 6,
    "type": "memory",
    "title": "海洋好朋友",
    "theme": "月亮海湾",
    "stationIndex": 1,
    "station": "热闹码头",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "starfish",
      "lighthouse",
      "boat",
      "lighthouse",
      "starfish",
      "boat"
    ]
  },
  {
    "id": 28,
    "day": 1,
    "index": 7,
    "type": "bridge",
    "title": "搭起小栈桥",
    "theme": "月亮海湾",
    "stationIndex": 1,
    "station": "热闹码头",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "bridge",
    "targets": [
      "triangle",
      "square",
      "moon",
      "heart"
    ],
    "items": [
      "square",
      "heart",
      "moon",
      "triangle"
    ]
  },
  {
    "id": 29,
    "day": 1,
    "index": 8,
    "type": "pattern",
    "title": "贝壳花边",
    "theme": "月亮海湾",
    "stationIndex": 1,
    "station": "热闹码头",
    "brief": "看前面的规律，补上最后一个。",
    "voice": "pattern",
    "cycle": [
      "shell",
      "shell",
      "fish"
    ],
    "series": [
      "shell",
      "shell",
      "fish",
      "shell",
      "shell"
    ],
    "answer": "fish",
    "choices": [
      "shell",
      "fish",
      "starfish"
    ]
  },
  {
    "id": 30,
    "day": 1,
    "index": 9,
    "type": "sequence",
    "title": "灯塔的信号",
    "theme": "月亮海湾",
    "stationIndex": 1,
    "station": "热闹码头",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "blue",
      "green",
      "yellow"
    ]
  },
  {
    "id": 31,
    "day": 1,
    "index": 10,
    "type": "order",
    "title": "小船排排队",
    "theme": "月亮海湾",
    "stationIndex": 2,
    "station": "月亮灯塔",
    "brief": "从最小的开始，一个一个点。",
    "voice": "intro-2-3",
    "icon": "boat",
    "sizes": [
      56,
      42,
      28
    ],
    "introText": "来到月亮灯塔，从最小的开始排队吧！"
  },
  {
    "id": 32,
    "day": 1,
    "index": 11,
    "type": "puzzle",
    "title": "拼好月亮灯塔",
    "theme": "月亮海湾",
    "stationIndex": 2,
    "station": "月亮灯塔",
    "brief": "对照小图，把拼图片放回原位。",
    "voice": "puzzle",
    "picture": "lighthouse",
    "cols": 2,
    "rows": 2,
    "pieces": [
      1,
      3,
      2,
      0
    ]
  },
  {
    "id": 33,
    "day": 1,
    "index": 12,
    "type": "find",
    "title": "海星捉迷藏",
    "theme": "月亮海湾",
    "stationIndex": 2,
    "station": "月亮灯塔",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "find",
    "target": "starfish",
    "items": [
      "starfish",
      "starfish",
      "starfish",
      "pear",
      "lighthouse",
      "starfish"
    ]
  },
  {
    "id": 34,
    "day": 1,
    "index": 13,
    "type": "sort",
    "title": "把行李装船",
    "theme": "月亮海湾",
    "stationIndex": 2,
    "station": "月亮灯塔",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "sort",
    "categories": [
      "clothes",
      "toy"
    ],
    "items": [
      {
        "category": "clothes",
        "icon": "sock"
      },
      {
        "category": "toy",
        "icon": "ball"
      },
      {
        "category": "clothes",
        "icon": "hat"
      },
      {
        "category": "toy",
        "icon": "car"
      },
      {
        "category": "clothes",
        "icon": "shirt"
      }
    ]
  },
  {
    "id": 35,
    "day": 1,
    "index": 14,
    "type": "bridge",
    "title": "彩色浮桥",
    "theme": "月亮海湾",
    "stationIndex": 2,
    "station": "月亮灯塔",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "bridge",
    "targets": [
      "square",
      "moon",
      "heart",
      "star"
    ],
    "items": [
      "moon",
      "star",
      "heart",
      "square"
    ]
  },
  {
    "id": 36,
    "day": 1,
    "index": 15,
    "type": "count",
    "title": "分享野餐水果",
    "theme": "月亮海湾",
    "stationIndex": 3,
    "station": "海湾小屋",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "intro-2-4",
    "count": 4,
    "icon": "pear",
    "choices": [
      2,
      1,
      4
    ],
    "introText": "来到海湾小屋，数一数准备了几个吧！"
  },
  {
    "id": 37,
    "day": 1,
    "index": 16,
    "type": "memory",
    "title": "海风记忆卡",
    "theme": "月亮海湾",
    "stationIndex": 3,
    "station": "海湾小屋",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "pear",
      "lighthouse",
      "boat",
      "boat",
      "lighthouse",
      "pear"
    ]
  },
  {
    "id": 38,
    "day": 1,
    "index": 17,
    "type": "sequence",
    "title": "航行指示灯",
    "theme": "月亮海湾",
    "stationIndex": 3,
    "station": "海湾小屋",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "coral",
      "blue",
      "green"
    ]
  },
  {
    "id": 39,
    "day": 1,
    "index": 18,
    "type": "order",
    "title": "贝壳从小到大",
    "theme": "月亮海湾",
    "stationIndex": 3,
    "station": "海湾小屋",
    "brief": "从最小的开始，一个一个点。",
    "voice": "order",
    "icon": "shell",
    "sizes": [
      42,
      56,
      28
    ]
  },
  {
    "id": 40,
    "day": 1,
    "index": 19,
    "type": "care",
    "title": "小熊海边晚安",
    "theme": "月亮海湾",
    "stationIndex": 3,
    "station": "海湾小屋",
    "brief": "放好枕头、盖被子，再关掉灯。",
    "voice": "pillow",
    "animal": "bear"
  },
  {
    "id": 41,
    "day": 2,
    "index": 0,
    "type": "maze",
    "title": "走进云朵城",
    "theme": "云朵星球",
    "stationIndex": 0,
    "station": "云朵入口",
    "brief": "点相邻的安全格，走到小旗那里。",
    "voice": "intro-3-1",
    "cols": 4,
    "rows": 3,
    "blocked": [
      1,
      5,
      7
    ],
    "start": 0,
    "end": 3,
    "solution": [
      0,
      4,
      8,
      9,
      10,
      6,
      2,
      3
    ],
    "companion": "dino",
    "introText": "来到云朵入口，沿安全的小路前进吧！"
  },
  {
    "id": 42,
    "day": 2,
    "index": 1,
    "type": "sequence",
    "title": "星球欢迎灯",
    "theme": "云朵星球",
    "stationIndex": 0,
    "station": "云朵入口",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "green",
      "blue",
      "coral"
    ]
  },
  {
    "id": 43,
    "day": 2,
    "index": 2,
    "type": "puzzle",
    "title": "修好小火箭",
    "theme": "云朵星球",
    "stationIndex": 0,
    "station": "云朵入口",
    "brief": "对照小图，把拼图片放回原位。",
    "voice": "puzzle",
    "picture": "rocket",
    "cols": 3,
    "rows": 2,
    "pieces": [
      5,
      1,
      4,
      3,
      0,
      2
    ]
  },
  {
    "id": 44,
    "day": 2,
    "index": 3,
    "type": "find",
    "title": "收集小星球",
    "theme": "云朵星球",
    "stationIndex": 0,
    "station": "云朵入口",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "find",
    "target": "planet",
    "items": [
      "planet",
      "planet",
      "planet",
      "rocket",
      "star",
      "planet",
      "planet",
      "dino"
    ]
  },
  {
    "id": 45,
    "day": 2,
    "index": 4,
    "type": "pattern",
    "title": "宇宙花纹",
    "theme": "云朵星球",
    "stationIndex": 0,
    "station": "云朵入口",
    "brief": "看前面的规律，补上最后一个。",
    "voice": "pattern",
    "cycle": [
      "planet",
      "star",
      "rocket"
    ],
    "series": [
      "planet",
      "star",
      "rocket",
      "planet",
      "star"
    ],
    "answer": "rocket",
    "choices": [
      "planet",
      "star",
      "rocket"
    ]
  },
  {
    "id": 46,
    "day": 2,
    "index": 5,
    "type": "count",
    "title": "给飞船补给",
    "theme": "云朵星球",
    "stationIndex": 1,
    "station": "星球小站",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "intro-3-2",
    "count": 4,
    "icon": "planet",
    "choices": [
      4,
      1,
      3
    ],
    "introText": "来到星球小站，数一数准备了几个吧！"
  },
  {
    "id": 47,
    "day": 2,
    "index": 6,
    "type": "memory",
    "title": "太空玩偶配对",
    "theme": "云朵星球",
    "stationIndex": 1,
    "station": "星球小站",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "heart",
      "planet",
      "heart",
      "dino",
      "planet",
      "dino"
    ]
  },
  {
    "id": 48,
    "day": 2,
    "index": 7,
    "type": "sort",
    "title": "整理宇航行李",
    "theme": "云朵星球",
    "stationIndex": 1,
    "station": "星球小站",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "sort",
    "categories": [
      "fruit",
      "toy",
      "clothes"
    ],
    "items": [
      {
        "category": "toy",
        "icon": "car"
      },
      {
        "category": "clothes",
        "icon": "hat"
      },
      {
        "category": "clothes",
        "icon": "shirt"
      },
      {
        "category": "fruit",
        "icon": "banana"
      },
      {
        "category": "toy",
        "icon": "ball"
      },
      {
        "category": "fruit",
        "icon": "apple"
      }
    ]
  },
  {
    "id": 49,
    "day": 2,
    "index": 8,
    "type": "spot",
    "title": "星空找不同",
    "theme": "云朵星球",
    "stationIndex": 1,
    "station": "星球小站",
    "brief": "仔细比较，点右边不同的地方。",
    "voice": "spot",
    "left": [
      "planet",
      "rocket",
      "star",
      "satellite",
      "heart",
      "dino"
    ],
    "right": [
      "rocket",
      "rocket",
      "star",
      "satellite",
      "heart",
      "rocket"
    ],
    "differences": [
      0,
      5
    ]
  },
  {
    "id": 50,
    "day": 2,
    "index": 9,
    "type": "bridge",
    "title": "接通星光桥",
    "theme": "云朵星球",
    "stationIndex": 1,
    "station": "星球小站",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "bridge",
    "targets": [
      "moon",
      "heart",
      "star",
      "circle",
      "triangle"
    ],
    "items": [
      "heart",
      "triangle",
      "circle",
      "star",
      "moon"
    ]
  },
  {
    "id": 51,
    "day": 2,
    "index": 10,
    "type": "order",
    "title": "火箭发射排队",
    "theme": "云朵星球",
    "stationIndex": 2,
    "station": "空间营地",
    "brief": "从最小的开始，一个一个点。",
    "voice": "intro-3-3",
    "icon": "rocket",
    "sizes": [
      54,
      44,
      24,
      34
    ],
    "introText": "来到空间营地，从最小的开始排队吧！"
  },
  {
    "id": 52,
    "day": 2,
    "index": 11,
    "type": "find",
    "title": "找回爱心星",
    "theme": "云朵星球",
    "stationIndex": 2,
    "station": "空间营地",
    "brief": "找出和目标一样的所有小伙伴。",
    "voice": "find",
    "target": "star",
    "items": [
      "star",
      "star",
      "planet",
      "star",
      "star",
      "star",
      "satellite",
      "rocket"
    ]
  },
  {
    "id": 53,
    "day": 2,
    "index": 12,
    "type": "sequence",
    "title": "空间站密码",
    "theme": "云朵星球",
    "stationIndex": 2,
    "station": "空间营地",
    "brief": "先看彩灯示范，再照着顺序点。",
    "voice": "sequence",
    "colors": [
      "blue",
      "coral",
      "yellow",
      "green"
    ],
    "sequence": [
      "blue",
      "yellow",
      "green",
      "coral"
    ]
  },
  {
    "id": 54,
    "day": 2,
    "index": 13,
    "type": "memory",
    "title": "云朵记忆盒",
    "theme": "云朵星球",
    "stationIndex": 2,
    "station": "空间营地",
    "brief": "翻开卡片，找到两个一样的图案。",
    "voice": "memory",
    "cards": [
      "planet",
      "dino",
      "rocket",
      "star",
      "star",
      "rocket",
      "planet",
      "dino"
    ]
  },
  {
    "id": 55,
    "day": 2,
    "index": 14,
    "type": "count",
    "title": "点数小卫星",
    "theme": "云朵星球",
    "stationIndex": 2,
    "station": "空间营地",
    "brief": "数一数，选择一样多的圆点。",
    "voice": "count",
    "count": 5,
    "icon": "satellite",
    "choices": [
      5,
      1,
      2
    ]
  },
  {
    "id": 56,
    "day": 2,
    "index": 15,
    "type": "bridge",
    "title": "铺好回程桥",
    "theme": "云朵星球",
    "stationIndex": 3,
    "station": "晚安星港",
    "brief": "把桥板放进相同图案的空位。",
    "voice": "intro-3-4",
    "targets": [
      "heart",
      "star",
      "circle",
      "triangle",
      "square"
    ],
    "items": [
      "square",
      "heart",
      "star",
      "circle",
      "triangle"
    ],
    "introText": "来到晚安星港，一起把桥板放好吧！"
  },
  {
    "id": 57,
    "day": 2,
    "index": 16,
    "type": "sort",
    "title": "太空衣物归位",
    "theme": "云朵星球",
    "stationIndex": 3,
    "station": "晚安星港",
    "brief": "看篮子图案，把物品分类送回家。",
    "voice": "sort",
    "categories": [
      "fruit",
      "toy",
      "clothes"
    ],
    "items": [
      {
        "category": "clothes",
        "icon": "shirt"
      },
      {
        "category": "toy",
        "icon": "ball"
      },
      {
        "category": "toy",
        "icon": "block"
      },
      {
        "category": "fruit",
        "icon": "apple"
      },
      {
        "category": "fruit",
        "icon": "pear"
      },
      {
        "category": "clothes",
        "icon": "sock"
      }
    ]
  },
  {
    "id": 58,
    "day": 2,
    "index": 17,
    "type": "maze",
    "title": "返回星光卧室",
    "theme": "云朵星球",
    "stationIndex": 3,
    "station": "晚安星港",
    "brief": "点相邻的安全格，走到小旗那里。",
    "voice": "maze",
    "cols": 4,
    "rows": 3,
    "blocked": [
      4,
      6,
      10
    ],
    "start": 8,
    "end": 0,
    "solution": [
      8,
      9,
      5,
      1,
      0
    ],
    "companion": "dino"
  },
  {
    "id": 59,
    "day": 2,
    "index": 18,
    "type": "order",
    "title": "睡前玩偶排队",
    "theme": "云朵星球",
    "stationIndex": 3,
    "station": "晚安星港",
    "brief": "从最小的开始，一个一个点。",
    "voice": "order",
    "icon": "bear",
    "sizes": [
      24,
      54,
      44,
      34
    ]
  },
  {
    "id": 60,
    "day": 2,
    "index": 19,
    "type": "care",
    "title": "小恐龙晚安",
    "theme": "云朵星球",
    "stationIndex": 3,
    "station": "晚安星港",
    "brief": "放好枕头、盖被子，再关掉灯。",
    "voice": "pillow",
    "animal": "dino"
  }
];

},
"src/layout.js":function(require,module,exports){
const WIDTH = 1280;
const HEIGHT = 720;
const UI = {
  back: { x: 26, y: 24, w: 82, h: 62 },
  start: { x: 645, y: 515, w: 410, h: 82 },
  end: { x: 490, y: 608, w: 300, h: 80 },
  parentMenu: { x: 130, y: 24, w: 160, h: 76 },
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
  if(require('./variety-challenges').isVariety(l.type))return require('./variety-layout').layoutFor(l);
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
  if(l.type==='maze'){
    out.items=grid(l.cols*l.rows,{x:500,y:228,w:620,h:345,columns:l.cols,gap:12});
  }
  if(l.type==='puzzle'){
    out.board={x:420,y:245,w:360,h:300};
    out.reference={x:720,y:145,w:100,h:83};
    const w=out.board.w/l.cols,h=out.board.h/l.rows;
    out.targets=l.pieces.map((_,i)=>({x:out.board.x+(i%l.cols)*w,y:out.board.y+Math.floor(i/l.cols)*h,w,h,index:i,value:i}));
    out.items=l.pieces.map((value,i)=>({x:830+(i%l.cols)*w+w*.075,y:245+Math.floor(i/l.cols)*h+h*.075,w:w*.85,h:h*.85,index:i,value}));
  }
  if(l.type==='spot'){
    out.reference=grid(l.left.length,{x:425,y:255,w:345,h:300,columns:2,gap:16});
    out.items=grid(l.right.length,{x:840,y:255,w:345,h:300,columns:2,gap:16});
  }
  if(l.type==='pattern'){
    out.series=row(l.series.length+1,245,750,105,435);
    out.items=row(3,445,750,115,435).map((r,i)=>({...r,value:l.choices[i]}));
  }
  return out;
}
module.exports = { layoutFor, row, grid };

},
"src/variety-layout.js":function(require,module,exports){
const rules=require('./variety-challenges');
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
const inside=(r,p)=>!!p&&p.x>=r.x&&p.y>=r.y&&p.x<=r.x+r.w&&p.y<=r.y+r.h;
function row(count,x,y,w,h,gap=20){const cell=(w-gap*(count-1))/count;return Array.from({length:count},(_,index)=>({x:x+index*(cell+gap),y,w:cell,h,index}));}
function layoutFor(l){
 const m={items:[],targets:[],controls:[],help:null};
 if(l.type==='trace')m.items=l.points.map(([x,y],index)=>({x:470+x*670-39,y:250+y*260-39,w:78,h:78,index}));
 if(l.type==='clean'){
  m.board={x:455,y:220,w:690,h:340};const cols=l.patches===12?4:3,rows=Math.ceil(l.patches/cols);
  m.items=Array.from({length:l.patches},(_,index)=>({x:m.board.x+index%cols*m.board.w/cols,y:m.board.y+Math.floor(index/cols)*m.board.h/rows,w:m.board.w/cols,h:m.board.h/rows,index}));
 }
 if(l.type==='mix'){
  m.bowl={x:490,y:250,w:360,h:150};m.target={x:995,y:245,w:130,h:130};
  m.items=row(3,440,430,480,130,20).map((r,i)=>({...r,value:l.colors[i]}));
  m.controls=[{x:970,y:420,w:210,h:70,action:{type:'clear'}},{x:970,y:500,w:210,h:80,action:{type:'mix'}}];
 }
 if(l.type==='rotate')m.items=row(l.icons.length,430,265,750,270,25);
 if(l.type==='share'){
  m.targets=row(l.recipients.length,430,230,750,240,25).map((r,index)=>({...r,value:index}));
  m.items=row(l.gifts.length,450,495,710,84,30);
 }
 if(l.type==='balance'){
  m.items=[{x:440,y:490,w:155,h:85,index:0,value:l.weights[0]},{x:615,y:490,w:155,h:85,index:1,value:l.weights[1]}];
  m.controls=[{x:800,y:490,w:165,h:85,action:{type:'undo'}},{x:990,y:490,w:190,h:85,action:{type:'weigh'}}];
  m.right={x:900,y:310,w:230,h:135,value:'right'};
 }
 if(l.type==='listen'){
  m.help={x:445,y:145,w:190,h:64};m.items=row(l.choices.length,435,295,740,230,25).map((r,index)=>({...r,value:l.choices[index]}));
 }
 if(l.type==='hide'){
  m.help={x:445,y:145,w:190,h:64};m.shown=row(l.shown.length,440,230,740,125,20);
  m.items=row(l.choices.length,450,430,720,130,25).map((r,index)=>({...r,value:l.choices[index]}));
 }
 return m;
}
function actionAt(l,c,m,point){
 if(rules.complete(l,c))return null;
 if(m.help&&inside(m.help,point))return l.type==='listen'?{type:'hint'}:{type:'replay'};
 const control=m.controls.find(r=>inside(r,point));if(control)return {...control.action};
 const r=m.items.find(r=>inside(r,point));if(!r)return null;
 if(l.type==='trace')return {type:'trace',index:r.index};
 if(l.type==='clean')return {type:'wipe',index:r.index};
 if(l.type==='mix')return {type:'color',value:r.value};
 if(l.type==='rotate')return {type:'rotate',index:r.index};
 if(l.type==='balance')return {type:'add',value:r.value};
 if(l.type==='listen'||l.type==='hide'&&c.mode==='choose')return {type:'answer',value:r.value};
 return null;
}
function lineRect(from,to,r){
 let low=0,high=1;const dx=to.x-from.x,dy=to.y-from.y;
 for(const [p,q]of [[-dx,from.x-r.x],[dx,r.x+r.w-from.x],[-dy,from.y-r.y],[dy,r.y+r.h-from.y]]){
  if(p===0){if(q<0)return null;continue;}const t=q/p;
  if(p<0)low=Math.max(low,t);else high=Math.min(high,t);if(low>high)return null;
 }
 return low;
}
function pointerActions(l,c,m,from,to){
 if(!from||!to||rules.complete(l,c))return [];
 if(l.type==='clean')return m.items.filter(r=>!c.cleared.includes(r.index)).map(r=>({r,t:lineRect(from,to,r)})).filter(x=>x.t!==null).sort((a,b)=>a.t-b.t).map(x=>({type:'wipe',index:x.r.index}));
 if(l.type!=='trace')return [];
 if(c.reached===0&&!inside(m.items[0],from))return [];
 const actions=[];let last=-1;
 for(let index=c.reached;index<m.items.length;index++){
  const hit=lineRect(from,to,m.items[index]);if(hit===null||hit<last)break;
  actions.push({type:'trace',index});last=hit;
 }
 return actions;
}
module.exports={layoutFor,actionAt,pointerActions};

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
const parentPanel=require('./parent-panel');
const {backdrop}=require('./scene-art');
const {heroForState}=require('./heroes');
const PALETTES = [
  ["#bec7f7", "#c3e8cf"],
  ["#bcd9ed", "#c7e4e3"],
  ["#d0c7ef", "#dde5f5"],
];
function outdoor(ctx,day=0,station=0){backdrop(ctx,day,station);}
function room(ctx, darkness = 0) {
  ctx.fillStyle = fx.tint("#c8c5f5", "#7e87bd", darkness);
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = fx.tint("#f7e5da", "#9da8ca", darkness);
  ctx.fillRect(0, 440, 1280, 280);
  p.round(ctx, 440, 150, 170, 120, 29, "#f5dcc9");
  p.round(ctx, 450, 160, 150, 100, 23, "#41649c");
  p.moon(ctx, 548, 194, 22, "#41649c");
}
function soundLabel(s,ui){
  if(s.muted)return '声音：关';
  const status=ui.audio&&ui.audio.status;
  if(status==='error')return '重试声音';
  if(status==='locked'||status==='blocked')return '点此开声';
  if(status==='loading'||status==='unlocking')return '声音准备中';
  return '声音：开';
}
function drawScene(ctx, s, ui) {
  const hero=ui.hero||heroForState(s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  if (ui.loading || ui.error) {
    ctx.fillStyle = PALETTES[0][0];
    ctx.fillRect(0, 0, 1280, 720);
    p.text(
      ctx,
      ui.error ? "图片还没准备好" : `小铭和${hero.name}正在准备出发`,
      640,
      325,
      35,
    );
    if (ui.error) p.button(ctx, UI.retry, "重试");
    return;
  }
  if (s.scene === "home") {
    outdoor(ctx, Math.max(0, model.availableDay(s, ui.today)));
    fx.drawDuo(ctx, ui.images[hero.adventure], characterRect(s.scene), ui, hero.adventure);
    p.text(ctx, `这关伙伴：${hero.name}`, 180, 650, 21);
    p.text(ctx, "小铭和奥特伙伴的晚安冒险", 800, 87, 40);
    p.text(ctx, "三组小冒险 · 每组20关", 800, 145, 26);
    const open = model.availableDay(s, ui.today);
    DAYS.forEach((r, i) => {
      const done = s.completed[i] === 20,
        locked = !done && open !== i;
      p.round(ctx, r.x, r.y, r.w, r.h, 27, locked ? "#e0e5ee" : p.C.cream);
      p.text(ctx, `第 ${i + 1} 组`, r.x + r.w / 2, r.y + 42, 29);
      p.text(ctx, DAY_THEMES[i], r.x + r.w / 2, r.y + 86, 25);
      p.text(ctx, '三位伙伴轮流陪你', r.x + r.w / 2, r.y + 113, 16, '#63769e');
      p.text(ctx, `${parentPanel.displayProgress(s,i)} / 20 关`, r.x + r.w / 2, r.y + 145, 25);
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
          ? `家长开启第 ${open + 1} 组`
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
          ? "新任务已就绪，已通关进度保留"
          : "点点角色，他们会打招呼；进度会保存"),
      815,
      622,
      22,
      "#6276a4",
    );
    p.button(ctx, UI.mute, soundLabel(s,ui), 21);

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
    fx.drawDuo(ctx, ui.images[hero.bedtime], characterRect(s.scene), ui, hero.bedtime);
    if (s.scene === "goodnight") p.button(ctx, UI.end, "结束", 37);
    else
      p.text(
        ctx,
        s.completed.every((n) => n === 20)
          ? "谢谢你和奥特伙伴一起冒险"
          : "这次冒险完成啦，好好休息吧",
        640,
        643,
        29,
      );

    fx.drawOverlay(ctx, ui, s.scene);
    return;
  }
  const l = model.currentLevel(s),
    c = s.challenge,
    done = model.isComplete(s);
  if (l.type === "care") {
    const sleep = fx.latest(ui, "sleep");
    room(ctx, c.step === 3 ? (sleep ? fx.ease(sleep.progress) : 1) : 0);
  } else outdoor(ctx, l.day, l.stationIndex);
  fx.drawDuo(ctx, ui.images[hero.adventure], characterRect(s.scene), ui, hero.adventure);
  drawChallenge(ctx, l, c, ui.layout, ui);
  p.text(ctx, `${hero.name}陪你闯关`, 158, 608, 18, '#607c99');
  p.text(ctx,l.station,158,630,20,'#607c99');
  for(let i=0;i<4;i++){
    p.oval(ctx,88+i*45,665,10,10,i<=l.stationIndex?'#efcc73':'#dce4ef');
    if(i===l.stationIndex)p.oval(ctx,88+i*45,665,4,4,'#8f7956');
  }
  p.button(ctx, UI.back, "‹", 57);
  p.text(ctx, `第${l.id}关 · ${l.title}`, 680, 55, 34);
  p.text(
    ctx,
    `第 ${l.day + 1} 组 · ${l.station} · ${l.index + 1}/20关`,
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
    p.button(ctx, UI.next, l.index === 19 ? `和${hero.name}说晚安` : "继续", 28);
  } else {
    p.round(ctx, 274, 621, 916, 74, 31, p.C.cream);
    p.text(ctx, ui.message || challenge.instruction(l, c), 698, 659, 25);
    p.speaker(ctx, 1144, 656, s.muted);
  }

  fx.drawOverlay(ctx, ui, s.scene);
}
function render(ctx,s,ui){drawScene(ctx,s,ui);parentPanel.entry(ctx);if(ui.parentPanel)parentPanel.drawPanel(ctx,s,ui.parentPanel);}
module.exports = { render };

},
"src/challenge-draw.js":function(require,module,exports){
const p = require("./paint");
const { icon, animal, dots, COLORS } = require("./icons");
const ch = require("./challenges");
const {drawAdvanced}=require('./advanced-draw');
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
  if(require('./variety-challenges').isVariety(l.type)){require('./variety-draw').drawVariety(ctx,l,c,layout,ui);return;}
  if(drawAdvanced(ctx,l,c,layout,ui))return;
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
    p.text(ctx, "点一点，一起数数", 810, 215, 26);
    layout.objects.forEach((r) => {
      fx.withItem(ctx, ui, -1 - r.index, r, () => {
        const a = center(r), ordinal = (c.counted || []).indexOf(r.index);
        ctx.save();
        ctx.lineWidth = 2;
        p.oval(ctx, a.x, a.y, 48, 48, ordinal >= 0 ? "#e0efcf" : "#edf0ef");
        icon(ctx, l.icon, a.x, a.y, 78);
        if (ordinal >= 0) {
          const y = r.y + r.h + 28;
          p.oval(ctx, a.x, y, 18, 18, "#ffe7a4");
          p.text(ctx, String(ordinal + 1), a.x, y, 24);
        }
        ctx.restore();
      });
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
  } else if (['rabbit','bear','dino'].includes(kind)) {
    animal(ctx,kind,0,0,size/120);
  } else if (kind==='pillow') {
    p.pillow(ctx,{x:-r,y:-r*.65,w:size,h:size*.65});
  } else if (kind==='tree') {
    p.round(ctx,-r*.12,-r*.1,r*.24,r*.95,5,'#b28c67');p.oval(ctx,0,-r*.35,r*.75,r*.67,'#8fbb8b');p.oval(ctx,-r*.32,-r*.08,r*.52,r*.4,'#a7ce98');
  } else if(kind==='flower') {
    p.round(ctx,-3,0,6,r*.9,3,'#81b48d');
    for(let i=0;i<5;i++){const a=i*Math.PI*2/5;p.oval(ctx,Math.cos(a)*r*.42,Math.sin(a)*r*.42-r*.2,r*.34,r*.34,'#f0a9bf');}
    p.oval(ctx,0,-r*.2,r*.26,r*.26,'#f5d37a');
  } else if(kind==='leaf') {
    ctx.fillStyle='#8cbe93';ctx.beginPath();ctx.moveTo(-r*.75,r*.65);ctx.quadraticCurveTo(-r*.9,-r*.8,r*.85,-r*.7);ctx.quadraticCurveTo(r*.7,r*.8,-r*.75,r*.65);ctx.fill();
    ctx.strokeStyle='#548e77';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-r*.6,r*.5);ctx.lineTo(r*.55,-r*.4);ctx.stroke();
  } else if(kind==='mushroom') {
    p.round(ctx,-r*.22,-r*.1,r*.44,r*.95,9,'#f3ddbc');ctx.fillStyle='#e8a3a7';ctx.beginPath();ctx.arc(0,0,r*.85,Math.PI,0);ctx.closePath();ctx.fill();p.oval(ctx,-r*.3,-r*.35,r*.13,r*.1,'#fff4dd');p.oval(ctx,r*.28,-r*.45,r*.12,r*.1,'#fff4dd');
  } else if(kind==='shell') {
    ctx.fillStyle='#eeb9c8';ctx.beginPath();ctx.moveTo(0,r*.7);ctx.bezierCurveTo(-r*1.25,r*.1,-r*.9,-r*.9,0,-r*.8);ctx.bezierCurveTo(r*.9,-r*.9,r*1.25,r*.1,0,r*.7);ctx.fill();
    ctx.strokeStyle='#d18fa9';ctx.lineWidth=2;for(let i=-2;i<=2;i++){ctx.beginPath();ctx.moveTo(0,r*.6);ctx.lineTo(i*r*.27,-r*.5);ctx.stroke();}
  } else if(kind==='fish') {
    ctx.fillStyle='#edb37e';ctx.beginPath();ctx.moveTo(-r*.45,0);ctx.lineTo(-r*.95,-r*.55);ctx.lineTo(-r*.95,r*.55);ctx.closePath();ctx.fill();p.oval(ctx,0,0,r*.7,r*.48,'#f2be87');p.oval(ctx,r*.36,-r*.1,r*.06,r*.07,'#55708d');
  } else if(kind==='starfish') {
    p.star(ctx,0,0,r*.9,'#f0b0a1');p.oval(ctx,-r*.18,-r*.05,3,4,'#856b77');p.oval(ctx,r*.18,-r*.05,3,4,'#856b77');
  } else if(kind==='boat') {
    ctx.fillStyle='#e6a2a4';ctx.beginPath();ctx.moveTo(-r,-r*.05);ctx.lineTo(r,-r*.05);ctx.lineTo(r*.6,r*.55);ctx.lineTo(-r*.55,r*.55);ctx.closePath();ctx.fill();p.round(ctx,-3,-r*.95,6,r*.9,2,'#af977e');ctx.fillStyle='#fff4d4';ctx.beginPath();ctx.moveTo(r*.08,-r*.9);ctx.lineTo(r*.8,-r*.18);ctx.lineTo(r*.08,-r*.18);ctx.fill();
  } else if(kind==='lighthouse') {
    ctx.fillStyle='#faf1dc';ctx.beginPath();ctx.moveTo(-r*.3,-r*.6);ctx.lineTo(r*.3,-r*.6);ctx.lineTo(r*.48,r*.8);ctx.lineTo(-r*.48,r*.8);ctx.closePath();ctx.fill();p.round(ctx,-r*.34,-r*.1,r*.68,r*.23,2,'#92b5d9');p.round(ctx,-r*.4,r*.42,r*.8,r*.2,2,'#92b5d9');p.round(ctx,-r*.3,-r*.7,r*.6,r*.35,3,'#f7d67f');ctx.fillStyle='#db929d';ctx.beginPath();ctx.moveTo(-r*.45,-r*.7);ctx.lineTo(0,-r);ctx.lineTo(r*.45,-r*.7);ctx.fill();
  } else if(kind==='planet') {
    p.oval(ctx,0,0,r*.66,r*.66,'#ad9cda');ctx.save();ctx.rotate(-.35);ctx.strokeStyle='#edce83';ctx.lineWidth=r*.16;ctx.scale(1,.27);ctx.beginPath();ctx.arc(0,0,r*.98,0,Math.PI*2);ctx.stroke();ctx.restore();p.oval(ctx,-r*.2,-r*.25,r*.13,r*.1,'#c4b6ea');
  } else if(kind==='rocket') {
    ctx.fillStyle='#f0a1a3';ctx.beginPath();ctx.moveTo(-r*.25,r*.1);ctx.lineTo(-r*.7,r*.75);ctx.lineTo(-r*.3,r*.6);ctx.moveTo(r*.25,r*.1);ctx.lineTo(r*.7,r*.75);ctx.lineTo(r*.3,r*.6);ctx.fill();p.oval(ctx,0,-r*.05,r*.36,r*.86,'#dce9f2');ctx.fillStyle='#eea6a6';ctx.beginPath();ctx.moveTo(-r*.27,-r*.6);ctx.lineTo(0,-r);ctx.lineTo(r*.27,-r*.6);ctx.fill();p.oval(ctx,0,-r*.16,r*.2,r*.2,'#8cbbe7');p.oval(ctx,0,r*.82,r*.17,r*.2,'#f4d27a');
  } else if(kind==='satellite') {
    p.round(ctx,-r*.3,-r*.36,r*.6,r*.72,7,'#f0d07a');p.round(ctx,-r,-r*.5,r*.55,r,4,'#8fb5da');p.round(ctx,r*.45,-r*.5,r*.55,r,4,'#8fb5da');ctx.strokeStyle='#fff3d3';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-r,-r*.05);ctx.lineTo(r,-r*.05);ctx.stroke();
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
"src/advanced-draw.js":function(require,module,exports){
const p=require('./paint');
const {icon}=require('./icons');
const art=require('./scene-art');
const fx=require('./feedback-draw');
const rules=require('./challenges');
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
function drawAdvanced(ctx,l,c,m,ui){
 if(l.type==='maze'){
  p.button(ctx,m.help,'指一指路',23);
  const first=m.items[0],last=m.items[m.items.length-1];
  ctx.save();ctx.lineWidth=2;p.round(ctx,first.x-12,first.y-12,last.x+last.w-first.x+24,last.y+last.h-first.y+24,24,'#d7e3ee','#a7becd');ctx.restore();
  const hinted=ui.peek?rules.mazeHint(l,c):-1;
  m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{
   const a=center(r),blocked=l.blocked.includes(r.index);
   ctx.save();ctx.lineWidth=2;p.round(ctx,r.x,r.y,r.w,r.h,18,blocked?'#a7c7b2':c.trail.includes(r.index)?'#f9e4af':'#fff3dc','#b5c9d5');ctx.restore();
   if(blocked)icon(ctx,['tree','shell','planet'][l.day],a.x,a.y,Math.min(65,r.h*.65));
   if(r.index===l.end){ctx.save();ctx.strokeStyle='#899dba';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(a.x-10,a.y-28);ctx.lineTo(a.x-10,a.y+29);ctx.stroke();ctx.fillStyle='#efa8bc';ctx.beginPath();ctx.moveTo(a.x-8,a.y-26);ctx.lineTo(a.x+24,a.y-13);ctx.lineTo(a.x-8,a.y);ctx.fill();ctx.restore();}
   if(r.index===hinted){ctx.save();ctx.strokeStyle='#e6b860';ctx.lineWidth=5;p.round(ctx,r.x+4,r.y+4,r.w-8,r.h-8,14,null,'#e6b860');ctx.restore();}
  }));
  let a=center(m.items[c.cell]);const move=fx.latest(ui,'mazeStep');
  if(move){const b=center(move.from),d=center(move.to),t=fx.ease(move.progress);a={x:b.x+(d.x-b.x)*t,y:b.y+(d.y-b.y)*t-Math.sin(t*Math.PI)*9};}
  p.star(ctx,a.x,a.y,Math.min(30,m.items[0].h*.29),'#ffdc71',true);
  return true;
 }
 if(l.type==='puzzle'){
  p.button(ctx,m.help,'看完整图',23);art.picture(ctx,l.picture,m.reference);
  ctx.save();ctx.globalAlpha=ui.peek ? .65 : .15;art.picture(ctx,l.picture,m.board);ctx.restore();
  m.targets.forEach(r=>{ctx.save();ctx.setLineDash([7,6]);ctx.lineWidth=2;p.round(ctx,r.x,r.y,r.w,r.h,3,null,'#b0a7a0');ctx.restore();const source=l.pieces.indexOf(r.value);const moving=fx.events(ui).some(e=>e.kind==='puzzleMove'&&e.index===source);if(c.placed.includes(source)&&!moving)art.tile(ctx,l,r.value,r);});
  m.items.forEach(r=>{
   const moving=fx.events(ui).some(e=>e.kind==='puzzleMove'&&e.index===r.index);
   if(c.placed.includes(r.index)||moving||ui.drag&&ui.drag.moved&&ui.drag.index===r.index)return;
   ctx.save();if(ui.selected===r.index){ctx.shadowColor='#f7ce67';ctx.shadowBlur=17;}art.tile(ctx,l,l.pieces[r.index],r);ctx.restore();
  });
  if(ui.drag&&ui.drag.moved){const r=m.items[ui.drag.index];art.tile(ctx,l,l.pieces[r.index],{...r,x:ui.drag.x-r.w/2,y:ui.drag.y-r.h/2});}
  return true;
 }
 if(l.type==='spot'){
  p.text(ctx,'看左边',598,218,25);p.text(ctx,'点右边不同的地方',1012,218,25);
  m.reference.forEach(r=>{const a=center(r);p.round(ctx,r.x,r.y,r.w,r.h,16,'#e8effa');icon(ctx,l.left[r.index],a.x,a.y,Math.min(70,r.h*.7));});
  m.items.forEach(r=>{fx.withItem(ctx,ui,r.index,r,()=>{const a=center(r);p.round(ctx,r.x,r.y,r.w,r.h,16,c.found.includes(r.index)?'#d8edcb':'#fff3dc');icon(ctx,l.right[r.index],a.x,a.y,Math.min(70,r.h*.7));if(c.found.includes(r.index))p.text(ctx,'✓',r.x+r.w-20,r.y+20,25,'#649875');});});
  return true;
 }
 if(l.type==='pattern'){
  p.text(ctx,'下一个是谁呢？',810,203,27);
  m.series.forEach((r,i)=>{const a=center(r);p.round(ctx,r.x,r.y,r.w,r.h,18,'#e7eef8');if(i<l.series.length)icon(ctx,l.series[i],a.x,a.y,62);else if(c.solved)icon(ctx,l.answer,a.x,a.y,62);else p.text(ctx,'?',a.x,a.y,45,'#8598bb');});
  m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{const a=center(r);p.button(ctx,r,'',24);icon(ctx,r.value,a.x,a.y,68);}));
  return true;
 }
 return false;
}
module.exports={drawAdvanced};

},
"src/scene-art.js":function(require,module,exports){
const p=require('./paint');
const {icon,animal}=require('./icons');
const PALETTES=[['#c4cef4','#cce7cc'],['#c2ddec','#bfe0e4'],['#cec8ed','#e0e7f5']];
function backdrop(ctx,day=0,station=0){
 const [sky,ground]=PALETTES[day];ctx.save();ctx.fillStyle=sky;ctx.fillRect(0,0,1280,720);
 p.moon(ctx,1118,195,28,sky);ctx.fillStyle=ground;ctx.beginPath();ctx.moveTo(0,385);ctx.quadraticCurveTo(650,285,1280,345);ctx.lineTo(1280,720);ctx.lineTo(0,720);ctx.fill();
 ctx.strokeStyle='#fff1d9';ctx.lineWidth=64;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(90,710);ctx.bezierCurveTo(150,540,1120,535,1100,305);ctx.stroke();ctx.lineWidth=2;
 if(day===0){
  icon(ctx,'tree',32,330,110);icon(ctx,'tree',1240,350,105);
  if(station===0){ctx.fillStyle='#e6b6a2';ctx.beginPath();ctx.moveTo(322,395);ctx.lineTo(367,315);ctx.lineTo(410,395);ctx.fill();ctx.fillStyle='#f9edcf';ctx.beginPath();ctx.moveTo(349,395);ctx.lineTo(367,345);ctx.lineTo(386,395);ctx.fill();}
  if(station===1){ctx.fillStyle='#a7d9e5';ctx.beginPath();ctx.moveTo(355,440);ctx.bezierCurveTo(400,560,960,570,1280,610);ctx.lineTo(1280,643);ctx.bezierCurveTo(900,600,390,610,333,450);ctx.fill();icon(ctx,'mushroom',362,420,58);}
  if(station===2){icon(ctx,'flower',360,420,60);icon(ctx,'flower',1237,575,75);icon(ctx,'leaf',350,570,45);}
  if(station===3){smallHouse(ctx,1190,230,1,'#efbdce');icon(ctx,'flower',355,520,60);}
 }else if(day===1){
  ctx.strokeStyle='#93cbd9';ctx.lineWidth=5;for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(20+i*15,460+i*55);ctx.quadraticCurveTo(130,480+i*55,230,455+i*55);ctx.stroke();ctx.beginPath();ctx.moveTo(1215,440+i*75);ctx.quadraticCurveTo(1250,454+i*75,1280,440+i*75);ctx.stroke();}
  icon(ctx,station===2?'lighthouse':'boat',1238,300,100);icon(ctx,station===0?'shell':station===1?'boat':station===2?'starfish':'shell',360,435,65);
  if(station===3)smallHouse(ctx,1180,200,.8,'#b5d0e6');
 }else{
  [[30,350,70],[1230,390,70],[370,570,42]].forEach(([x,y,r])=>{p.oval(ctx,x-r*.45,y,r*.7,r*.38,'#f1effc');p.oval(ctx,x+r*.35,y,r*.8,r*.48,'#f1effc');});
  icon(ctx,station===0?'planet':station===1?'satellite':station===2?'rocket':'moon',360,295,65);icon(ctx,station===3?'rocket':'planet',1240,555,85);
  if(station===3)smallHouse(ctx,1190,225,.85,'#c9bce9');
 }
 ctx.restore();
}
function smallHouse(ctx,x,y,s,color){ctx.save();ctx.translate(x,y);ctx.scale(s,s);p.round(ctx,-42,-30,84,70,16,'#fff0d7');ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(-50,-25);ctx.lineTo(0,-70);ctx.lineTo(50,-25);ctx.fill();p.round(ctx,-14,0,28,40,12,'#c6aa8e');p.oval(ctx,25,-5,9,11,'#f5d57b');ctx.restore();}
function picture(ctx,kind,rect){
 ctx.save();ctx.translate(rect.x,rect.y);ctx.scale(rect.w/400,rect.h/340);ctx.fillStyle='#d5e7f5';ctx.fillRect(0,0,400,340);
 p.oval(ctx,325,64,31,31,'#ffe49d');p.oval(ctx,80,65,65,23,'#fff7e7');p.oval(ctx,115,50,40,28,'#fff7e7');
 if(kind==='treehouse'){
  ctx.fillStyle='#c9e1ae';ctx.fillRect(0,225,400,115);icon(ctx,'tree',100,183,255);smallHouse(ctx,235,205,1.8,'#dca5ae');animal(ctx,'rabbit',230,270,.55);icon(ctx,'flower',54,293,40);
 }else if(kind==='boat'){
  ctx.fillStyle='#99cfdf';ctx.fillRect(0,230,400,110);icon(ctx,'boat',205,200,265);ctx.strokeStyle='#e3f2f6';ctx.lineWidth=7;for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(20+i*120,290);ctx.quadraticCurveTo(65+i*120,310,110+i*120,288);ctx.stroke();}
 }else if(kind==='lighthouse'){
  ctx.fillStyle='#a8d4df';ctx.fillRect(0,240,400,100);ctx.fillStyle='#e9d9b6';ctx.beginPath();ctx.moveTo(90,295);ctx.quadraticCurveTo(200,230,330,295);ctx.fill();icon(ctx,'lighthouse',220,180,260);icon(ctx,'shell',70,286,55);
 }else{
  ctx.fillStyle='#b4b3df';ctx.fillRect(0,0,400,340);icon(ctx,'planet',79,83,100);icon(ctx,'rocket',245,174,255);icon(ctx,'star',67,270,48);icon(ctx,'star',342,70,38);
 }
 ctx.restore();
}
function tile(ctx,l,piece,rect){
 ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.w,rect.h);ctx.clip();
 picture(ctx,l.picture,{x:rect.x-(piece%l.cols)*rect.w,y:rect.y-Math.floor(piece/l.cols)*rect.h,w:rect.w*l.cols,h:rect.h*l.rows});ctx.restore();
 ctx.save();ctx.lineWidth=2;p.round(ctx,rect.x,rect.y,rect.w,rect.h,2,null,'#fff8e4');ctx.restore();
}
module.exports={backdrop,picture,tile};

},
"src/feedback-draw.js":function(require,module,exports){
const p = require("./paint");
const { icon } = require("./icons");
const {poseAt,drawCharacter}=require('./character-motion');
const {tile}=require('./scene-art');
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
    if(e.kind==='puzzleMove'){
      const t=ease(e.progress),r={x:lerp(e.from.x,e.to.x,t),y:lerp(e.from.y,e.to.y,t)-Math.sin(Math.PI*t)*12,w:lerp(e.from.w,e.to.w,t),h:lerp(e.from.h,e.to.h,t)};
      tile(ctx,e,e.piece,r);
    }
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
// 新伙伴保留同一套小铭构图，按各自原图比例使用相同的前臂区域。
RIGS['adventure-tiga'] = {...RIGS.adventure};
RIGS['adventure-trigger'] = {...RIGS.adventure};
RIGS['bedtime-tiga'] = {...RIGS.bedtime};
RIGS['bedtime-trigger'] = {...RIGS.bedtime};

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
"src/variety-draw.js":function(require,module,exports){
const p=require('./paint');
const {icon,dots}=require('./icons');
const art=require('./scene-art');
const fx=require('./feedback-draw');
const rules=require('./variety-challenges');
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
const PAINT={red:'#ee9592',yellow:'#f4d577',blue:'#8ab6e4',orange:'#f1b274',green:'#a6c88e',purple:'#b5a4d5'};
const COLOR_NAMES={red:'红色',yellow:'黄色',blue:'蓝色'};
function mixture(selected){
 if(selected.length<2)return PAINT[selected[0]]||'#eef0ed';
 if(selected.includes('red')&&selected.includes('yellow'))return PAINT.orange;
 if(selected.includes('yellow')&&selected.includes('blue'))return PAINT.green;
 return PAINT.purple;
}
function animalFace(ctx,kind,x,y,size){
 const r=size/2;ctx.save();ctx.translate(x,y);
 const color=kind==='cat'?'#edbe96':kind==='dog'?'#d7b18f':'#f4d875';
 if(kind==='cat'){
  ctx.fillStyle=color;for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(side*r*.75,-r*.1);ctx.lineTo(side*r*.7,-r*.9);ctx.lineTo(side*r*.12,-r*.45);ctx.fill();}
 }else if(kind==='dog'){
  p.oval(ctx,-r*.7,-r*.2,r*.3,r*.62,'#b88f70');p.oval(ctx,r*.7,-r*.2,r*.3,r*.62,'#b88f70');
 }
 p.oval(ctx,0,0,r*.77,r*.69,color);
 p.oval(ctx,-r*.27,-r*.1,r*.055,r*.08,'#5b647e');p.oval(ctx,r*.27,-r*.1,r*.055,r*.08,'#5b647e');
 if(kind==='duck')p.oval(ctx,0,r*.24,r*.4,r*.18,'#eea36b');
 else{
  p.oval(ctx,0,r*.25,r*.36,r*.26,'#fff0d8');p.oval(ctx,0,r*.12,r*.1,r*.075,'#8b777d');
  ctx.strokeStyle='#9d8184';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,r*.3,r*.11,.1,Math.PI-.1);ctx.stroke();
  if(kind==='cat')for(const side of [-1,1])for(const dy of [0,.17]){ctx.beginPath();ctx.moveTo(side*r*.43,r*.14);ctx.lineTo(side*r*.9,r*dy);ctx.stroke();}
 }
 ctx.restore();
}
function drawTrace(ctx,l,c,m,ui){
 p.text(ctx,'连亮星星，画出一条小路',810,185,27);
 ctx.save();ctx.lineWidth=5;ctx.strokeStyle='#b4bdd6';ctx.setLineDash([8,10]);ctx.beginPath();
 m.items.forEach((r,i)=>{const a=center(r);if(i)ctx.lineTo(a.x,a.y);else ctx.moveTo(a.x,a.y);});ctx.stroke();ctx.setLineDash([]);
 if(c.reached>1){ctx.strokeStyle='#e8bd59';ctx.lineWidth=8;ctx.beginPath();m.items.slice(0,c.reached).forEach((r,i)=>{const a=center(r);if(i)ctx.lineTo(a.x,a.y);else ctx.moveTo(a.x,a.y);});ctx.stroke();}
 ctx.restore();
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{
  const a=center(r),done=r.index<c.reached,next=r.index===c.reached;
  if(next)p.oval(ctx,a.x,a.y,39,39,'#fff2cc');
  p.star(ctx,a.x,a.y,27,done?'#ffd36b':next?'#ffe8a0':'#d4dcf0',next);
  p.text(ctx,String(r.index+1),a.x,a.y+57,23,done?'#ae8a42':'#7584a9');
 }));
}
function drawClean(ctx,l,c,m,ui){
 p.text(ctx,'擦开小窗，看看藏着什么',810,178,27);
 ctx.save();ctx.lineWidth=10;p.round(ctx,m.board.x-7,m.board.y-7,m.board.w+14,m.board.h+14,24,'#b1bed7','#b1bed7');ctx.restore();
 art.picture(ctx,l.picture,m.board);
 m.items.forEach(r=>{
  const wiped=c.cleared.includes(r.index),event=fx.latest(ui,'clean',r.index);if(wiped&&!event)return;
  ctx.save();ctx.globalAlpha*=wiped?1-fx.ease(event.progress):1;
  p.round(ctx,r.x,r.y,r.w,r.h,1,'#e9f0f1');const a=center(r);
  p.oval(ctx,a.x-r.w*.18,a.y,r.w*.32,r.h*.25,'#f8f7ef');p.oval(ctx,a.x+r.w*.17,a.y-r.h*.13,r.w*.34,r.h*.3,'#f8f7ef');
  ctx.restore();
 });
 if(c.cleared.length===0){p.text(ctx,'用手指擦一擦',800,398,30,'#748ba6');}
}
function drawMix(ctx,l,c,m,ui){
 p.text(ctx,'两种颜色会变成什么？',680,190,27);p.text(ctx,'目标颜色',1060,210,25);
 const color=mixture(c.selected),target=center(m.target);
 p.oval(ctx,target.x,target.y,65,65,PAINT[l.targetColor]);
 if(c.solved)p.text(ctx,'✓',target.x,target.y,55,'#fff9df');
 ctx.save();ctx.lineWidth=5;p.round(ctx,m.bowl.x,m.bowl.y,m.bowl.w,m.bowl.h,62,'#f5f1e4','#b5c4d4');
 p.oval(ctx,m.bowl.x+m.bowl.w/2,m.bowl.y+70,m.bowl.w*.43,53,color);
 ctx.globalAlpha*=.45;p.oval(ctx,m.bowl.x+m.bowl.w*.34,m.bowl.y+47,47,10,'#ffffff');ctx.restore();
 c.selected.forEach((value,i)=>p.oval(ctx,627+i*85,370,16,16,PAINT[value]));
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{const a=center(r);p.button(ctx,r,'',24,c.selected.includes(r.value));p.oval(ctx,a.x,r.y+47,36,36,PAINT[r.value]);p.text(ctx,COLOR_NAMES[r.value],a.x,r.y+103,24);}));
 m.controls.forEach(r=>fx.withItem(ctx,ui,r.action.type==='clear'?-10:-11,r,()=>p.button(ctx,r,r.action.type==='clear'?'清空':'调色',26)));
}
function drawRotate(ctx,l,c,m,ui){
 p.text(ctx,'点一点，把图案转正',810,190,28);
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{
  const a=center(r),done=c.turns[r.index]===0,event=fx.latest(ui,'turn',r.index);
  p.round(ctx,r.x,r.y,r.w,r.h,24,done?'#dfedcf':'#fff3dc');icon(ctx,l.icons[r.index],a.x,r.y+37,46);
  ctx.save();ctx.translate(a.x,r.y+153);ctx.rotate((event?event.from+(event.to-event.from)*fx.ease(event.progress):c.turns[r.index])*Math.PI/2);icon(ctx,l.icons[r.index],0,0,114);ctx.restore();
  p.text(ctx,done?'✓':'↻',a.x,r.y+r.h-29,36,done?'#729a75':'#8191b3');
 }));
}
function giftCard(ctx,l,r,index,ui,active=false){
 fx.withItem(ctx,ui,index,r,()=>{p.button(ctx,r,'',24,active);const a=center(r);icon(ctx,l.gifts[index],a.x,a.y,62);});
}
function drawShare(ctx,l,c,m,ui){
 p.text(ctx,'每位伙伴，一份小点心',810,184,27);
 m.targets.forEach(r=>fx.withTarget(ctx,ui,r.value,r,()=>{
  const a=center(r),given=c.given.find(x=>x.target===r.value);
  p.round(ctx,r.x,r.y,r.w,r.h,27,given?'#e1edce':'#fff1db');icon(ctx,l.recipients[r.value],a.x,r.y+77,120);
  p.oval(ctx,a.x,r.y+188,r.w*.32,36,'#c6d9e7');p.oval(ctx,a.x,r.y+184,r.w*.29,30,'#f6f7ed');
  if(given&&!fx.moving(ui,given.index))icon(ctx,l.gifts[given.index],a.x,r.y+179,58);
  if(given)p.text(ctx,'✓',r.x+r.w-22,r.y+24,25,'#6b9b7d');
 }));
 m.items.forEach(r=>{
  if(c.given.some(x=>x.index===r.index)||fx.moving(ui,r.index)||ui.drag&&ui.drag.moved&&ui.drag.index===r.index)return;
  giftCard(ctx,l,r,r.index,ui,ui.selected===r.index);
 });
 if(ui.drag&&ui.drag.moved&&m.items[ui.drag.index]){const r=m.items[ui.drag.index];giftCard(ctx,l,{...r,x:ui.drag.x-r.w/2,y:ui.drag.y-r.h/2},r.index,ui,true);}
}
function blocks(ctx,count,x,y,color){
 for(let i=0;i<count;i++){const col=i%4,row=Math.floor(i/4),cols=Math.min(count,4);p.round(ctx,x+(col-(cols-1)/2)*30-12,y-row*27-24,24,24,5,color);}
}
function drawBalance(ctx,l,c,m,ui){
 p.text(ctx,'让两边一样重',810,182,29);
 const total=c.added.reduce((a,b)=>a+b,0),event=fx.latest(ui,'balance');
 const visual=event?event.from+(event.to-event.from)*fx.ease(event.progress):total;
 const angle=Math.max(-.18,Math.min(.18,(visual-l.target)*.055));
 const left={x:810-215*Math.cos(angle),y:280-215*Math.sin(angle)},right={x:810+215*Math.cos(angle),y:280+215*Math.sin(angle)};
 ctx.save();ctx.strokeStyle='#8da5bd';ctx.lineWidth=12;ctx.beginPath();ctx.moveTo(left.x,left.y);ctx.lineTo(right.x,right.y);ctx.stroke();
 ctx.fillStyle='#a5b7cc';ctx.beginPath();ctx.moveTo(810,270);ctx.lineTo(766,455);ctx.lineTo(854,455);ctx.closePath();ctx.fill();p.oval(ctx,810,280,17,17,'#f4d17c');
 for(const [pos,count,color]of [[left,l.target,'#94b7db'],[right,total,'#e8bf75']]){
  ctx.strokeStyle='#a5b5c5';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(pos.x,pos.y);ctx.lineTo(pos.x-90,pos.y+100);ctx.moveTo(pos.x,pos.y);ctx.lineTo(pos.x+90,pos.y+100);ctx.stroke();
  p.round(ctx,pos.x-105,pos.y+94,210,20,9,'#b7cadd');blocks(ctx,count,pos.x,pos.y+94,color);
 }
 ctx.restore();
 p.text(ctx,'照着左边配一配',590,449,22);p.text(ctx,c.solved?'一样重啦！':'可以取回再试试',1030,449,22);
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{p.button(ctx,r,'',25);const a=center(r);dots(ctx,r.value,a.x,a.y,13);}));
 m.controls.forEach(r=>fx.withItem(ctx,ui,r.action.type==='undo'?-10:-11,r,()=>p.button(ctx,r,r.action.type==='undo'?'取回一块':'称好了',25)));
}
function drawListen(ctx,l,c,m,ui){
 p.button(ctx,m.help,'看提示',25);p.text(ctx,'听一听，谁在叫？',840,221,29);
 const names={cat:'小猫',dog:'小狗',duck:'小鸭'};
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{
  const a=center(r),target=r.value===l.answer;
  p.round(ctx,r.x,r.y,r.w,r.h,25,c.solved&&target?'#deedcd':'#fff3dc');
  if(ui.peek&&target){ctx.save();ctx.lineWidth=5;p.round(ctx,r.x+4,r.y+4,r.w-8,r.h-8,22,null,'#e2b35c');ctx.restore();}
  animalFace(ctx,r.value,a.x,r.y+90,143);p.text(ctx,names[r.value],a.x,r.y+190,27);
  if(c.solved&&target)p.text(ctx,'✓',r.x+r.w-24,r.y+26,29,'#759a76');
 }));
}
function drawHide(ctx,l,c,m,ui){
 p.button(ctx,m.help,'再看一眼',25);p.text(ctx,c.mode==='preview'?'先记住这些伙伴':'谁躲起来了？',858,184,27);
 m.shown.forEach(r=>{
  const a=center(r),hidden=c.mode==='choose'&&!c.solved&&r.index===l.hiddenIndex;
  p.round(ctx,r.x,r.y,r.w,r.h,22,hidden?'#afbfde':'#e9eff3');
  if(hidden)p.text(ctx,'?',a.x,a.y,58,'#fff5dc');else icon(ctx,l.shown[r.index],a.x,a.y,82);
 });
 m.items.forEach(r=>fx.withItem(ctx,ui,r.index,r,()=>{
  const a=center(r);ctx.save();if(c.mode==='preview')ctx.globalAlpha*=.35;
  p.button(ctx,r,'',25,c.solved&&r.value===l.shown[l.hiddenIndex]);icon(ctx,r.value,a.x,a.y,76);ctx.restore();
 }));
 if(c.mode==='preview')p.text(ctx,'先看上面，等伙伴躲好哦',810,390,24,'#778aa6');
}
const DRAW={trace:drawTrace,clean:drawClean,mix:drawMix,rotate:drawRotate,share:drawShare,balance:drawBalance,listen:drawListen,hide:drawHide};
function drawVariety(ctx,l,c,m,ui){const draw=DRAW[l.type];if(!draw)return false;ctx.save();draw(ctx,l,c,m,ui||{});ctx.restore();return true;}
module.exports={drawVariety};

},
"src/parent-panel.js":function(require,module,exports){
const p=require('./paint');
const model=require('./model');
const {UI}=require('./layout');
const PARENT_UI={
 close:{x:934,y:148,w:66,h:60},
 back:{x:440,y:520,w:400,h:72},
 reset:{x:315,y:414,w:300,h:78},
 next:{x:665,y:414,w:300,h:78},
 cancel:{x:330,y:440,w:280,h:80},
 confirm:{x:670,y:440,w:280,h:80},
};
function entry(ctx){p.button(ctx,UI.parentMenu,'家长',28);}
function displayProgress(s,index){return s.completed[index]+(index===s.day&&s.completed[index]<20&&model.isComplete(s)?1:0);}
function drawPanel(ctx,s,mode){
 ctx.save();ctx.fillStyle='rgba(39,51,88,.42)';ctx.fillRect(0,0,1280,720);
 p.round(ctx,260,125,760,490,30,'#fff8e8');p.text(ctx,'家长小面板',640,178,34);
 p.button(ctx,PARENT_UI.close,'×',32);
 if(mode==='menu'){
  for(let i=0;i<3;i++){
   const x=306+i*225;p.round(ctx,x,230,218,120,20,i===s.day?'#e0edfb':'#edf0f6');
   p.text(ctx,`第 ${i+1} 组`,x+109,257,24);p.text(ctx,`${displayProgress(s,i)} / 20 关`,x+109,294,25);
   p.text(ctx,s.completed[i]===20?'✓ 已打卡':i===s.day?'正在冒险':'尚未完成',x+109,327,18,s.completed[i]===20?'#54866b':'#7c8ca5');
  }
  const can=model.needsParent(s),all=s.completed.every(n=>n===20);
  p.text(ctx,can?'本组已完成，可以随时开启下一组':all?'三组任务全部完成啦':`本组还差 ${20-displayProgress(s,s.day)} 关，完成后再开启下一组`,640,380,24);
  p.button(ctx,PARENT_UI.reset,'重新开始',25);
  if(can)p.button(ctx,PARENT_UI.next,`开始第 ${model.availableDay(s)+1} 组`,26);
  else{p.round(ctx,PARENT_UI.next.x,PARENT_UI.next.y,PARENT_UI.next.w,PARENT_UI.next.h,24,'#e2e6ec');p.text(ctx,all?'已全部通关':'下一组未解锁',815,453,25,'#8793a4');}
  p.button(ctx,PARENT_UI.back,'回到游戏',25);
 }else{
  const reset=mode==='reset-confirm';
  p.text(ctx,reset?'确认清空全部冒险进度？':`现在开始第 ${model.availableDay(s)+1} 组吗？`,640,282,30);
  p.text(ctx,reset?'三组打卡和已过关记录都会重新开始。':'已经完成的关卡和打卡会保留。',640,338,24,'#71819a');
  p.button(ctx,PARENT_UI.cancel,'取消',28);p.button(ctx,PARENT_UI.confirm,reset?'确认重新开始':'确认出发',28);
 }
 ctx.restore();
}
module.exports={PARENT_UI,entry,drawPanel,displayProgress};

},
"src/heroes.js":function(require,module,exports){
const HEROES = [
  {id:'zero', name:'赛罗', adventure:'adventure', bedtime:'bedtime'},
  {id:'tiga', name:'迪迦', adventure:'adventure-tiga', bedtime:'bedtime-tiga'},
  {id:'trigger', name:'特利迦', adventure:'adventure-trigger', bedtime:'bedtime-trigger'},
];
function heroForState(state) {
  const index = state.day * 20 + Math.min(19, state.completed[state.day]);
  return HEROES[index % HEROES.length] || HEROES[0];
}
module.exports = {HEROES,heroForState};

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
        ["flight", "return", "flip", "shake", "pulse", "puzzleMove"].includes(kind) &&
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
          !(e.index === index && (["return", "shake", "pulse"].includes(e.kind)||(e.kind==='puzzleMove'&&e.failure))),
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
  if(require('./variety-challenges').isVariety(l.type))return require('./variety-feedback').actionFeedback(l,before,after,action,layout,meta);
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
  if(l.type==='maze'&&action.type==='move'&&r){
    if(changed){emit('mazeStep',{from:layout.items[before.cell],to:r},250);sounds.push('tap');}
    else if(action.index!==before.cell)retry();
  }
  if(l.type==='puzzle'&&action.type==='place'&&r&&!before.placed.includes(index)){
    const target=changed?layout.targets.find(t=>t.value===action.target):r;
    emit('puzzleMove',{index,piece:l.pieces[index],picture:l.picture,cols:l.cols,rows:l.rows,from:meta.from||r,to:target,failure:!changed},changed?420:300);
    sounds.push(changed?'place':'retry');
  }
  if(l.type==='spot'&&action.type==='pick'&&r){
    if(changed){emit('pulse',{index,rect:r},500);sounds.push('collect');}
    else if(!before.found.includes(index))retry();
  }
  if(l.type==='pattern'&&action.type==='answer'){
    const item=layout.items.find(x=>x.value===action.value);
    if(item){emit(changed?'pulse':'shake',{index:item.index,rect:item},500);sounds.push(changed?'match':'retry');}
  }
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
  if (l.type === "count" && action.type === "countObject" && changed) {
    const object = layout.objects[index];
    if (object) {
      // 负索引与答案卡片分开，物件点数不会带动下方答案。
      emit("pulse", { index: -1 - index, rect: object }, 380);
      sounds.push("tap");
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
"src/variety-feedback.js":function(require,module,exports){
const rules=require('./variety-challenges');
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
function actionFeedback(l,before,after,action,m,meta={}){
 const events=[],sounds=[];
 const emit=(kind,data,duration=380,delay=0)=>events.push({kind,data,duration,delay});
 if(!before||!after||rules.complete(l,before))return {events,sounds};
 const changed=before!==after,index=action.index,r=m.items[index];
 const pulse=(item,id=item.index)=>{emit('pulse',{index:id,rect:item});sounds.push('tap');};
 const retry=(item,id=item&&item.index)=>{if(item)emit('shake',{index:id,rect:item},330);sounds.push('retry');};
 if(l.type==='trace'&&action.type==='trace'&&r){if(changed){pulse(r);sounds[0]='collect';}else if(index>=before.reached)retry(r);}
 if(l.type==='clean'&&action.type==='wipe'&&r&&changed){emit('clean',{index,rect:r},440);sounds.push('collect');}
 if(l.type==='mix'){
  if(action.type==='color'&&changed){const item=m.items.find(x=>x.value===action.value);if(item)pulse(item);}
  if(action.type==='clear'&&changed)sounds.push('tap');
  if(action.type==='mix'){const item=m.controls.find(x=>x.action.type==='mix');if(changed){pulse(item,-11);sounds[0]='match';}else if(before.selected.length)retry(item,-11);}
 }
 if(l.type==='rotate'&&action.type==='rotate'&&r&&changed){emit('turn',{index,from:before.turns[index],to:before.turns[index]+1},280);sounds.push('tap');if(after.turns[index]===0)emit('pulse',{index,rect:r},420,220);}
 if(l.type==='share'&&action.type==='give'&&r&&!before.given.some(x=>x.index===index)){
  if(changed){const target=m.targets.find(x=>x.value===action.target),a=center(target);emit('flight',{index,sprite:l.gifts[index],style:'share',from:meta.from||r,to:{x:a.x-34,y:target.y+145,w:68,h:68}},440);emit('target',{value:target.value,rect:target},380,300);sounds.push('place');}
  else {emit('return',{index,sprite:l.gifts[index],style:'share',from:meta.from||r,to:r},300);sounds.push('retry');}
 }
 if(l.type==='balance'){
  if(changed&&(action.type==='add'||action.type==='undo')){
   emit('balance',{from:before.added.reduce((a,b)=>a+b,0),to:after.added.reduce((a,b)=>a+b,0)},360);sounds.push('place');
  }
  if(action.type==='weigh'){const item=m.controls.find(x=>x.action.type==='weigh');if(changed){pulse(item,-11);sounds[0]='match';}else retry(item,-11);}
 }
 if((l.type==='listen'||l.type==='hide')&&action.type==='answer'&&(l.type!=='hide'||before.mode==='choose')){
  const item=m.items.find(x=>x.value===action.value);if(item){if(changed){pulse(item);sounds[0]='match';}else retry(item);}
 }
 if(l.type==='hide'&&action.type==='replay'&&changed)sounds.push('tap');
 return {events,sounds};
}
module.exports={actionFeedback};

},
"src/voice-picker.js":function(require,module,exports){
const { GROUPS, LEGACY_LINES } = require('./voice-lines');

// 一组语音全部用过后再洗牌；场景之间各自保留进度。
function createVoicePicker(random = Math.random) {
  const groups = new Map();
  return {
    next(baseKey) {
      const lines = Object.prototype.hasOwnProperty.call(GROUPS, baseKey) ? GROUPS[baseKey] : null;
      if (!lines) return Object.prototype.hasOwnProperty.call(LEGACY_LINES, baseKey) ? baseKey : null;
      let state = groups.get(baseKey);
      if (!state) {
        state = { bag: [], last: null };
        groups.set(baseKey, state);
      }
      if (!state.bag.length) {
        state.bag = lines.map(x => x.key);
        for (let i = state.bag.length - 1; i > 0; i--) {
          const value = random();
          const j = Math.floor(Math.max(0, Math.min(.999999999, Number.isFinite(value) ? value : 0)) * (i + 1));
          [state.bag[i], state.bag[j]] = [state.bag[j], state.bag[i]];
        }
        if (state.bag.length > 1 && state.bag[0] === state.last)
          [state.bag[0], state.bag[1]] = [state.bag[1], state.bag[0]];
      }
      state.last = state.bag.shift();
      return state.last;
    },
  };
}
module.exports = { createVoicePicker };

},
"src/voice-lines.js":function(require,module,exports){
const { LEVELS } = require('./levels');

// 资源名与文案共用一份清单，浏览器、微信和语音生成均从这里读取。
const TEXTS = {
  welcome: [
    '小铭，准备好了吗？和奥特伙伴一起冒险吧。',
    '小铭，伙伴们在等你，开始小冒险吧。',
    '你好，小铭。和伙伴一起完成今晚的小任务吧。',
  ],
  success: [
    '小铭，你完成啦。我们一起继续吧。',
    '做得好，小铭！这个小任务完成啦。',
    '找到办法啦，小铭，给你一个小小的赞。',
    '小铭，真仔细。你把任务完成啦。',
    '成功啦！小铭和伙伴配合得真好。',
    '这一关完成啦，小铭，和伙伴击个掌吧。',
  ],
  daycomplete: [
    '小铭，这一组完成啦，打卡成功。和伙伴说晚安吧。',
    '这一组都完成啦。小铭，打个卡，好好休息吧。',
    '小铭，本组冒险完成啦。和奥特伙伴说晚安吧。',
  ],
  finished: [
    '小铭，所有冒险都完成啦。晚安，小小冒险家。',
    '每一组都打卡啦。小铭，安心睡个好觉吧。',
    '伙伴们的任务都完成啦。小铭，晚安。',
  ],
  find: [
    '小铭，看一看上面的小图案，找到所有一样的图案吧。',
    '看看上面的图案，把一样的都找出来吧。',
    '看好目标图案，点一点，找齐一样的朋友吧。',
  ],
  bridge: [
    '小铭，把桥板放到相同图案的位置吧。',
    '桥上还有空位。找相同的图案，把桥板放好吧。',
    '看好桥板图案，放进一样的空位吧。',
  ],
  count: [
    '数一数有几个，选出一样多的圆点吧。',
    '可以点一点图案数数，再选出一样多的圆点吧。',
    '慢慢数清图案，选出一样多的圆点吧。',
  ],
  sort: [
    '小铭，把东西送回同一类的篮子吧。',
    '看一看篮子上的图案，把同一类的东西放在一起吧。',
    '小铭，给物品找家。同一类，放进同一个篮子吧。',
  ],
  memory: [
    '翻开卡片，找出两张一样的图案吧。',
    '记住卡片图案，找找它的另一个朋友吧。',
    '轻轻翻开两张卡，看看图案是不是一样的。',
  ],
  sequence: [
    '看清亮灯顺序，再照着点一遍吧。',
    '先看彩灯怎么亮，再按同样的顺序点吧。',
    '先看彩灯示范，再照着亮灯顺序点吧。',
  ],
  order: [
    '小铭，从最小的开始，一个一个点吧。',
    '找找谁最小，再按从小到大排好队吧。',
    '小铭，从最小的开始，让它们从小到大排队吧。',
  ],
  maze: [
    '沿着小路，一步一步走到终点。点旁边的安全格子吧。',
    '点相邻的空格，绕开障碍，走到小旗那里吧。',
    '点旁边的安全格子，一步一步走到小旗那里吧。',
  ],
  puzzle: [
    '把图块放回正确的位置，拼出完整的画面吧。',
    '小铭，对照完整的小图，把图片放回原位吧。',
    '看看小图，把这些图片拼成完整画面吧。',
  ],
  spot: [
    '看看左右两边，点出右边不一样的地方吧。',
    '小铭，比一比左右，点右边不一样的图案吧。',
    '仔细比一比两边的图案。右边哪里变了呢？点一下吧。',
  ],
  pattern: [
    '看看前面的规律，选出接下来应该出现的图案。',
    '小铭，照着前面的规律，找出下一个图案吧。',
    '看看这些图案怎样轮流出现。问号的位置该放谁呢？',
  ],
  pillow: [
    '小铭，先把枕头放好吧。',
    '小伙伴想休息啦。先把小枕头放到头边吧。',
    '小铭，放好软软的枕头，让伙伴躺下吧。',
  ],
  blanket: [
    '小伙伴躺好啦，给它盖上小被子吧。',
    '小铭，轻轻盖好被子，让伙伴暖暖地休息吧。',
    '枕头放好啦。现在把被子盖到小伙伴身上吧。',
  ],
  lamp: [
    '小伙伴准备睡觉啦，轻轻点一下小灯吧。',
    '小铭，轻轻关掉小灯，让伙伴睡觉吧。',
    '小伙伴已经躺好啦。点一下小灯，我们轻轻说晚安。',
  ],
  trace: ['从亮着的星星开始，按顺序连起来吧。','小铭，点亮下一颗星星，也可以用手指连起来。','沿着星星的小路，慢慢连到最后一颗吧。'],
  clean: ['小铭，擦一擦白雾，看看窗外的风景吧。','用小手擦亮窗户，把白雾轻轻擦掉吧。','滑一滑手指，也可以点一点，把窗户擦干净吧。'],
  mix: ['选两种颜料，调出和目标一样的颜色吧。','看看目标颜色，选两种颜料，再点调色吧。','小铭，混合两种颜色试试。不一样可以清空重来。'],
  rotate: ['点一点图案，把它们转正吧。','小图案转歪啦，轻轻点它，让它站起来吧。','小铭，转一转，让每个图案都朝上吧。'],
  share: ['给每位伙伴一份点心，不多也不少。','小铭，把点心分给伙伴，每人一份吧。','把小点心送过去，让每位伙伴都分到一份。'],
  balance: ['添上或取回砝码，让天平两边一样重吧。','看看左边，再给右边加砝码，一样重就点称好了。','小铭，让天平平平的。放多了可以取回一块。'],
  'listen-cat': ['喵，喵，喵。听听是哪位小伙伴在叫？','喵喵，喵喵。谁在和我们打招呼呢？','小铭，听，喵，喵。找到发出这个声音的伙伴吧。'],
  'listen-dog': ['汪，汪，汪。听听是哪位小伙伴在叫？','汪汪，汪汪。谁在和我们打招呼呢？','小铭，听，汪，汪。找到发出这个声音的伙伴吧。'],
  'listen-duck': ['嘎，嘎，嘎。听听是哪位小伙伴在叫？','嘎嘎，嘎嘎。谁在和我们打招呼呢？','小铭，听，嘎，嘎。找到发出这个声音的伙伴吧。'],
  hide: ['先记住这些伙伴，看看谁躲起来了。','小铭，仔细看一看，等会儿谁会藏起来呢？','记住眼前的小伙伴，再找出躲起来的那一个。'],
};

const INTRO_ALTERNATIVES = {
  'intro-1-1': '星光营地到了，小铭，找齐和目标一样的图案吧！',
  'intro-1-2': '我们来到蘑菇溪桥啦，把同一类物品放在一起吧！',
  'intro-1-3': '花谷花园就在前面，找到相同图案，把桥板铺好吧！',
  'intro-1-4': '伙伴小屋在等你，沿着安全的小格子走过去吧！',
  'intro-2-1': '贝壳浅滩到了，选两种颜料，调出目标颜色吧！',
  'intro-2-2': '欢迎来到热闹码头，给这些物品分分类吧！',
  'intro-2-3': '月亮灯塔到了，先找最小的，再从小到大排好队吧！',
  'intro-2-4': '海湾小屋到了，按顺序连起星星，画出小路吧！',
  'intro-3-1': '云朵入口就在这里，点相邻的安全格子，向前走吧！',
  'intro-3-2': '星球小站到了，给每位伙伴分一份小点心吧！',
  'intro-3-3': '空间营地到了，从亮着的星星开始，连起来吧！',
  'intro-3-4': '晚安星港到了，擦掉白雾，看看窗外吧！',
};

for (const level of LEVELS) {
  if (level.introText) TEXTS[level.voice] = [level.introText, INTRO_ALTERNATIVES[level.voice]];
}
const GROUPS = Object.freeze(Object.fromEntries(Object.entries(TEXTS).map(([base, lines]) => [
  base, Object.freeze(lines.map((text, i) => Object.freeze({ key: i === 0 ? base : `${base}-${i + 1}`, text }))),
])));
const LEGACY_LINES = Object.freeze({
  stars: '小铭，点一点发光的星星吧。',
  goodnight: '今晚的冒险完成啦。晚安，小铭。',
});
const VOICE_KEYS = Object.freeze([...Object.values(GROUPS).flat().map(x => x.key), ...Object.keys(LEGACY_LINES)]);
module.exports = { GROUPS, LEGACY_LINES, VOICE_KEYS };

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
      offs.push(listen(canvas, "contextmenu", event => event.preventDefault()));
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
const { VOICE_KEYS } = require('../src/voice-lines');
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
  const url = (kind,key) => {
    const target=new URL(`assets/${kind}/${key}.mp3`,baseURI());
    if(kind==='audio'&&scope.__GAME_AUDIO_VERSION__)
      target.searchParams.set('v',scope.__GAME_AUDIO_VERSION__);
    return target.href;
  };

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

}},mapping={"preview/entry.js":{"../src/game":"src/game.js","./platform-browser":"preview/platform-browser.js"},"src/game.js":{"./model":"src/model.js","./challenges":"src/challenges.js","./calendar":"src/calendar.js","./layout":"src/layout.js","./challenge-layout":"src/challenge-layout.js","./draw":"src/draw.js","./parent-panel":"src/parent-panel.js","./character-motion":"src/character-motion.js","./feedback":"src/feedback.js","./heroes":"src/heroes.js","./voice-picker":"src/voice-picker.js","./variety-challenges":"src/variety-challenges.js","./variety-layout":"src/variety-layout.js"},"src/model.js":{"./levels":"src/levels.js","./challenges":"src/challenges.js","./calendar":"src/calendar.js","./legacy-v2":"src/legacy-v2.js","./legacy-v3":"src/legacy-v3.js"},"src/levels.js":{},"src/challenges.js":{"./variety-challenges":"src/variety-challenges.js"},"src/variety-challenges.js":{},"src/calendar.js":{},"src/legacy-v2.js":{},"src/legacy-v3.js":{},"src/layout.js":{},"src/challenge-layout.js":{"./variety-challenges":"src/variety-challenges.js","./variety-layout":"src/variety-layout.js"},"src/variety-layout.js":{"./variety-challenges":"src/variety-challenges.js"},"src/draw.js":{"./layout":"src/layout.js","./model":"src/model.js","./challenges":"src/challenges.js","./levels":"src/levels.js","./challenge-draw":"src/challenge-draw.js","./paint":"src/paint.js","./feedback-draw":"src/feedback-draw.js","./character-motion":"src/character-motion.js","./parent-panel":"src/parent-panel.js","./scene-art":"src/scene-art.js","./heroes":"src/heroes.js"},"src/challenge-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./challenges":"src/challenges.js","./advanced-draw":"src/advanced-draw.js","./feedback-draw":"src/feedback-draw.js","./variety-challenges":"src/variety-challenges.js","./variety-draw":"src/variety-draw.js"},"src/paint.js":{},"src/icons.js":{"./paint":"src/paint.js"},"src/advanced-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./scene-art":"src/scene-art.js","./feedback-draw":"src/feedback-draw.js","./challenges":"src/challenges.js"},"src/scene-art.js":{"./paint":"src/paint.js","./icons":"src/icons.js"},"src/feedback-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./character-motion":"src/character-motion.js","./scene-art":"src/scene-art.js"},"src/character-motion.js":{},"src/variety-draw.js":{"./paint":"src/paint.js","./icons":"src/icons.js","./scene-art":"src/scene-art.js","./feedback-draw":"src/feedback-draw.js","./variety-challenges":"src/variety-challenges.js"},"src/parent-panel.js":{"./paint":"src/paint.js","./model":"src/model.js","./layout":"src/layout.js"},"src/heroes.js":{},"src/feedback.js":{"./challenges":"src/challenges.js","./variety-challenges":"src/variety-challenges.js","./variety-feedback":"src/variety-feedback.js"},"src/variety-feedback.js":{"./variety-challenges":"src/variety-challenges.js"},"src/voice-picker.js":{"./voice-lines":"src/voice-lines.js"},"src/voice-lines.js":{"./levels":"src/levels.js"},"preview/platform-browser.js":{"../src/calendar":"src/calendar.js","./browser-audio":"preview/browser-audio.js"},"preview/browser-audio.js":{"../src/feedback":"src/feedback.js","../src/voice-lines":"src/voice-lines.js"}},cache={};function load(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](name=>load(mapping[id][name]),module,module.exports);return module.exports;}load("preview/entry.js");})();