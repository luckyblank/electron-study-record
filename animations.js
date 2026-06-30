/* animations.js — GSAP 驱动的动画工具模块
 * 在 renderer.js 之前加载，暴露 window.Anim。
 * 覆盖弹窗、吐司、宠物、徽章、进度环等高价值动画时刻。
 * CSS 仍负责 hover 微过渡与循环 keyframes（呼吸/眨眼/spin）。 */
(function () {
  // GSAP 未加载时的降级：暴露 no-op，保证应用核心功能不受影响。
  if (typeof window.gsap === 'undefined') {
    window.Anim = new Proxy({}, { get: () => () => {} });
    console.warn('[Anim] gsap 未加载，动画已降级');
    return;
  }

  // 匹配项目 --ease-out: cubic-bezier(0.16, 1, 0.3, 1) 的 GSAP 等价曲线
  var EASE_OUT = 'power3.out';
  var EASE_IN = 'power2.in';
  var EASE_INOUT = 'power2.inOut';
  var EASE_BACK = 'back.out(1.7)';

  gsap.defaults({ ease: EASE_OUT, duration: 0.26 });

  var reduceMotion = function () {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };
  var fast = function (dur) { return reduceMotion() ? 0 : dur; };

  // ---- 弹窗（Modal）----
  // 结构：<div.modal-root> > .modal-backdrop + .modal-panel
  // 用 WeakMap 记录每个 modal 的 timeline，便于打断/重入时 kill。
  var modalTimelines = new WeakMap();

  function killModalTL(el) {
    var tl = modalTimelines.get(el);
    if (tl) { tl.kill(); modalTimelines.delete(el); }
  }

  var modal = {
    show: function (el) {
      if (!el) return;
      var backdrop = el.querySelector('.modal-backdrop');
      var panel = el.querySelector('.modal-panel');
      killModalTL(el);
      if (backdrop) gsap.set(backdrop, { autoAlpha: 0 });
      if (panel) gsap.set(panel, { autoAlpha: 0, y: -10 });
      var tl = gsap.timeline();
      if (backdrop) tl.to(backdrop, { autoAlpha: 1, duration: fast(0.18), ease: 'power1.out' }, 0);
      if (panel) tl.to(panel, { autoAlpha: 1, y: 0, duration: fast(0.28), ease: EASE_OUT }, 0.02);
      modalTimelines.set(el, tl);
    },
    hide: function (el, onComplete) {
      if (!el) return;
      var backdrop = el.querySelector('.modal-backdrop');
      var panel = el.querySelector('.modal-panel');
      killModalTL(el);
      var tl = gsap.timeline({ onComplete: onComplete });
      if (panel) tl.to(panel, { autoAlpha: 0, y: -6, duration: fast(0.18), ease: EASE_IN }, 0);
      if (backdrop) tl.to(backdrop, { autoAlpha: 0, duration: fast(0.15), ease: 'power1.in' }, 0);
      modalTimelines.set(el, tl);
    }
  };

  // ---- 吐司（Toast）----
  var toast = {
    show: function (el) {
      el.style.transition = 'none'; // 屏蔽 CSS 过渡，避免与 GSAP 逐帧更新冲突
      gsap.set(el, { autoAlpha: 0, y: 10 });
      gsap.to(el, { autoAlpha: 0.96, y: 0, duration: fast(0.28), ease: EASE_OUT, overwrite: true });
    },
    hide: function (el, onComplete) {
      gsap.to(el, { autoAlpha: 0, y: -6, duration: fast(0.2), ease: EASE_IN, onComplete: onComplete, overwrite: true });
    }
  };

  // ---- 徽章解锁 ----
  // 注：#badge-unlock-toast 的 CSS transform 由 GSAP 接管（xPercent/yPercent 居中）。
  var badge = {
    unlock: function (toastEl, cardEl, iconEl, textEls) {
      // 关闭 CSS 上的 opacity/transform 过渡，避免与 GSAP 逐帧更新冲突
      toastEl.style.transition = 'none';
      gsap.set(toastEl, { xPercent: -50, yPercent: -50, autoAlpha: 0, scale: 0.7, y: -10 });
      var tl = gsap.timeline();
      tl.to(toastEl, { autoAlpha: 1, scale: 1, y: 0, duration: fast(0.42), ease: EASE_BACK });
      if (iconEl) {
        tl.fromTo(iconEl, { scale: 0.4, rotation: -25 }, { scale: 1, rotation: 0, duration: fast(0.5), ease: EASE_BACK }, 0.08);
      }
      if (textEls && textEls.length) {
        tl.from(textEls, { autoAlpha: 0, y: 8, stagger: 0.07, duration: fast(0.24), ease: EASE_OUT }, 0.18);
      }
      return tl;
    },
    hide: function (toastEl, onComplete) {
      return gsap.to(toastEl, { autoAlpha: 0, y: -10, scale: 0.92, duration: fast(0.3), ease: EASE_IN, onComplete: onComplete, overwrite: true });
    }
  };

  // ---- 进度环 ----
  // 直接 tween strokeDashoffset，并让百分比数字平滑计数。
  function progressRing(ring, offset, percentEl, percent) {
    if (!ring) return;
    gsap.to(ring, { strokeDashoffset: offset, duration: 0.7, ease: EASE_OUT, overwrite: 'auto' });
    if (percentEl) {
      var cur = parseInt(percentEl.textContent, 10) || 0;
      var proxy = { v: cur };
      gsap.to(proxy, {
        v: percent, duration: 0.7, ease: EASE_OUT, overwrite: true,
        onUpdate: function () { percentEl.textContent = Math.round(proxy.v) + '%'; }
      });
    }
  }

  // ---- 宠物 ----
  // celebrate / levelup 的 transform 由 GSAP 接管，需临时关闭 .pet-visual 上的
  // CSS transform 过渡，避免每帧被过渡平滑掉。
  function withNoTransition(el, fn) {
    var prev = el.style.transition;
    el.style.transition = 'none';
    var tl = fn();
    var restore = function () { el.style.transition = prev; };
    if (tl && tl.then) { tl.then(restore); }
    else if (tl) { tl.eventCallback('onComplete', restore); tl.eventCallback('onReverseComplete', restore); }
    else { restore(); }
    return tl;
  }

  var pet = {
    // 庆祝：弹跳缩放（替代原 petJumpBounce），不依赖 CSS class。
    celebrate: function (visual) {
      if (!visual) return;
      gsap.killTweensOf(visual);
      return withNoTransition(visual, function () {
        var tl = gsap.timeline();
        tl.fromTo(visual, { scale: 1, y: 0 },
          { scale: 1.12, y: -12, duration: 0.2, ease: 'power2.out' })
          .to(visual, { scale: 0.96, y: 2, duration: 0.16, ease: 'power2.in' })
          .to(visual, { scale: 1.03, y: -4, duration: 0.18, ease: 'power2.out' })
          .to(visual, { scale: 1, y: 0, duration: 0.26, ease: 'back.out(2)', clearProps: 'scale,y' });
        return tl;
      });
    },
    // 升级：缩放弹跳 + boxShadow 光晕脉冲（替代原 petLevelGlow）。
    levelup: function (visual) {
      if (!visual) return;
      gsap.killTweensOf(visual);
      // 光晕脉冲：使用 accent 色的简单 boxShadow 序列。
      var glow = '0 0 0 0 rgba(124,159,255,0.34)';
      var glowMid = '0 0 0 14px rgba(124,159,255,0), 0 14px 30px rgba(124,159,255,0.32)';
      withNoTransition(visual, function () {
        var tl = gsap.timeline();
        tl.fromTo(visual, { scale: 1 },
          { scale: 1.15, duration: 0.2, ease: 'power2.out' })
          .to(visual, { scale: 0.95, duration: 0.18, ease: 'power2.in' })
          .to(visual, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.5)', clearProps: 'scale' });
        // 平行的 boxShadow 脉冲（独立 tween，不与 transform 冲突）
        gsap.fromTo(visual,
          { boxShadow: glow },
          { boxShadow: glowMid, duration: 0.5, ease: 'power2.out', overwrite: 'auto' });
        gsap.to(visual, { boxShadow: glow, duration: 0.9, ease: 'power1.out', delay: 0.5, overwrite: 'auto', clearProps: 'boxShadow' });
        return tl;
      });
    },
    // 粒子：DOM 创建 + GSAP 浮动（替代原 petParticleFloat keyframe）。
    particles: function (symbols, count, rect) {
      if (!rect) return;
      for (var i = 0; i < count; i++) {
        var el = document.createElement('div');
        el.className = 'pet-particle';
        el.textContent = symbols[i % symbols.length];
        el.style.left = (rect.left + rect.width / 2 + (Math.random() - 0.5) * 36) + 'px';
        el.style.top = (rect.top + rect.height / 2 + (Math.random() - 0.5) * 18) + 'px';
        el.style.animation = 'none'; // 屏蔽 CSS petParticleFloat，交由 GSAP 驱动
        document.body.appendChild(el);
        var drift = (Math.random() - 0.5) * 62;
        gsap.set(el, { xPercent: -50, yPercent: -50, autoAlpha: 1, scale: 0.84, rotation: 0 });
        gsap.to(el, {
          y: '-=' + (72 + Math.random() * 24),
          x: '+=' + drift,
          autoAlpha: 0,
          scale: 1.25,
          rotation: 220,
          duration: 1.2 + Math.random() * 0.3,
          ease: 'power1.out',
          onComplete: function () { el.remove(); }
        });
      }
    },
    // EXP 弹出（替代原 petExpFloat keyframe）。
    expPop: function (text, rect) {
      if (!rect) return;
      var el = document.createElement('div');
      el.className = 'pet-exp-pop';
      el.textContent = text;
      el.style.left = (rect.left + rect.width / 2) + 'px';
      el.style.top = (rect.top + 4) + 'px';
      el.style.animation = 'none'; // 屏蔽 CSS petExpFloat，交由 GSAP 驱动
      document.body.appendChild(el);
      gsap.set(el, { xPercent: -50, autoAlpha: 0, y: 0, scale: 0.9 });
      var tl = gsap.timeline({ onComplete: function () { el.remove(); } });
      tl.to(el, { autoAlpha: 1, duration: 0.15, ease: 'power1.out' })
        .to(el, { y: -58, autoAlpha: 0, scale: 1.08, duration: 1.1, ease: 'power1.out' }, 0.12);
    }
  };

  window.Anim = {
    modal: modal,
    toast: toast,
    badge: badge,
    pet: pet,
    progressRing: progressRing,
    reduceMotion: reduceMotion,
    killTweensOf: function (t) { gsap.killTweensOf(t); }
  };
})();
