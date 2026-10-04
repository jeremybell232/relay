// relay toolbar — drop into any local page:
//   <script src="http://localhost:4400/relay.js" defer></script>
// Freezes the current DOM (styles and assets inlined, scripts stripped) and
// posts it to the relay server, which puts it on the canvas.
(() => {
  if (window.__relay) return;
  window.__relay = true;

  const SERVER = document.currentScript ? new URL(document.currentScript.src).origin : "http://localhost:4400";
  const MAX_ASSET = 2 * 1024 * 1024;
  const HOST_ID = "__relay-toolbar";
  // The canvas tab's name; the canvas page names itself the same way.
  const CANVAS_TAB = `relay-canvas-${new URL(SERVER).port || "80"}`;

  // ---------------------------------------------------------------- capture

  const abs = (u, base = location.href) => {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  };

  const assetCache = new Map();
  const inlineAsset = (url) => {
    if (!/^https?:/.test(url)) return Promise.resolve(url);
    if (!assetCache.has(url)) {
      assetCache.set(
        url,
        fetch(url, { mode: "cors", credentials: "same-origin" })
          .then((r) => (r.ok ? r.blob() : Promise.reject()))
          .then((blob) =>
            blob.size > MAX_ASSET
              ? url
              : new Promise((resolve) => {
                  const fr = new FileReader();
                  fr.onload = () => resolve(fr.result);
                  fr.onerror = () => resolve(url);
                  fr.readAsDataURL(blob);
                }),
          )
          .catch(() => url),
      );
    }
    return assetCache.get(url);
  };

  const frameDoc = (el) => {
    try {
      const fd = el.contentDocument;
      return fd && fd.documentElement && fd.URL !== "about:blank" ? fd : null;
    } catch {
      return null; // cross-origin
    }
  };

  // The canvas shows the whole page at full height, where 100vh would mean "the whole
  // page". Freeze viewport-relative units to the pixel sizes they had when captured.
  const VP_RE = /(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))([sld]?)(vh|vmin|vmax)\b/gi; // not inside names like .h-100vh
  const freezeViewportUnits = (css) =>
    css.replace(VP_RE, (m, n, _, unit) => {
      const u = unit.toLowerCase();
      const base = u === "vh" ? innerHeight : u === "vmin" ? Math.min(innerWidth, innerHeight) : Math.max(innerWidth, innerHeight);
      return `${+((parseFloat(n) * base) / 100).toFixed(2)}px`;
    });

  const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

  // Make every url() absolute against `base`, then swap in data URIs where we can.
  const inlineCssUrls = async (css, base) => {
    const urls = new Set();
    css = css.replace(URL_RE, (m, q, u) => {
      if (u.startsWith("data:") || u.startsWith("#")) return m;
      const a = abs(u, base);
      urls.add(a);
      return `url("${a}")`;
    });
    const map = new Map(await Promise.all([...urls].map(async (u) => [u, await inlineAsset(u)])));
    return css.replace(/url\("([^"]+)"\)/g, (m, u) => (map.has(u) ? `url("${map.get(u)}")` : m));
  };

  // Text of a stylesheet, reading cssRules so CSS-in-JS rules added via
  // insertRule are included. Returns null when the sheet is cross-origin.
  const sheetText = (sheet, links, docBase) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return null;
    }
    const base = sheet.href || docBase;
    let out = "";
    for (const rule of rules) {
      // type 3 = @import; instanceof would fail for sheets from an iframe's realm.
      if (rule.type === 3) {
        const inner = rule.styleSheet && sheetText(rule.styleSheet, links, base);
        const media = rule.media && rule.media.mediaText;
        if (inner == null) links.push({ href: abs(rule.href, base), media });
        else out += media ? `@media ${media} {\n${inner}\n}\n` : inner + "\n";
      } else {
        // Relative url()s are relative to the sheet, not the page — fix that up front.
        out += rule.cssText.replace(URL_RE, (m, q, u) => (u.startsWith("data:") ? m : `url("${abs(u, base)}")`)) + "\n";
      }
    }
    return out;
  };

  // Captures `d` (the page, or recursively a same-origin iframe's document).
  async function capture(d = document) {
    const pageBase = d.baseURI;
    const live = d.documentElement;
    const clone = live.cloneNode(true);

    // 1. Copy live state into the clone. Both lists line up because the clone
    //    hasn't been touched yet.
    const liveEls = live.querySelectorAll("*");
    const cloneEls = clone.querySelectorAll("*");
    const replacements = [];
    for (let i = 0; i < liveEls.length; i++) {
      const el = liveEls[i];
      const c = cloneEls[i];
      if (!c) continue;
      const tag = el.localName;
      if (tag === "input") {
        if (el.type === "checkbox" || el.type === "radio") c.toggleAttribute("checked", el.checked);
        else if (el.type !== "file" && el.type !== "password") c.setAttribute("value", el.value);
      } else if (tag === "textarea") {
        c.textContent = el.value;
      } else if (tag === "select") {
        [...el.options].forEach((o, j) => c.options[j] && c.options[j].toggleAttribute("selected", o.selected));
      } else if (tag === "canvas") {
        try {
          const img = document.createElement("img");
          for (const a of el.attributes) img.setAttribute(a.name, a.value);
          img.src = el.toDataURL();
          replacements.push([c, img]);
        } catch {} // tainted canvas: leave it blank
      } else if ((tag === "iframe" || tag === "frame") && frameDoc(el)) {
        // Same-origin frame: freeze it too and embed it inline. The canvas restores its scroll.
        c.setAttribute("srcdoc", await capture(frameDoc(el)));
        c.removeAttribute("src");
        c.setAttribute("sandbox", "allow-same-origin");
        c.setAttribute("data-relay-scroll", `${el.contentWindow.scrollX},${el.contentWindow.scrollY}`);
      } else if (tag === "iframe" || tag === "frame" || tag === "embed" || tag === "object") {
        const r = el.getBoundingClientRect();
        const box = document.createElement("div");
        if (el.id) box.id = el.id;
        if (el.className && typeof el.className === "string") box.className = el.className;
        box.setAttribute(
          "style",
          `${el.getAttribute("style") || ""};width:${r.width}px;height:${r.height}px;display:grid;place-items:center;` +
            "background:repeating-linear-gradient(45deg,#0000 0 8px,#8881 8px 16px);border:1px dashed #8886;" +
            "font:12px system-ui;color:#888;box-sizing:border-box",
        );
        box.textContent = `${tag}${el.src ? ` · ${el.src}` : ""}`;
        replacements.push([c, box]);
      } else if (tag === "img") {
        if (el.currentSrc) c.setAttribute("src", el.currentSrc);
        c.removeAttribute("srcset");
        c.removeAttribute("sizes");
        c.removeAttribute("loading");
      }

      // Scrolled containers (a long list, a panel) keep their scroll position.
      if ((el.scrollTop || el.scrollLeft) && tag !== "iframe" && tag !== "frame") {
        c.setAttribute("data-relay-scroll-el", `${el.scrollLeft},${el.scrollTop}`);
      }

      // Open shadow roots → declarative shadow DOM (one level deep).
      if (el.shadowRoot && el.id !== HOST_ID) {
        const tpl = document.createElement("template");
        tpl.setAttribute("shadowrootmode", "open");
        let css = "";
        for (const s of el.shadowRoot.adoptedStyleSheets || []) css += sheetText(s, [], pageBase) || "";
        tpl.innerHTML = (css ? `<style>${css}</style>` : "") + el.shadowRoot.innerHTML;
        c.prepend(tpl);
      }
    }
    for (const [from, to] of replacements) from.replaceWith(to);

    // 2. Strip anything that runs, plus relay itself.
    const strip = (root) => {
      root
        .querySelectorAll(
          `script, noscript, base, #${HOST_ID}, meta[http-equiv="refresh" i], ` +
            'link[rel~="modulepreload"], link[rel~="preload"], link[rel~="prefetch"], link[rel~="manifest"], picture > source',
        )
        .forEach((n) => n.remove());
      root.querySelectorAll("*").forEach((n) => {
        for (const a of [...n.attributes]) {
          if (a.name.startsWith("on") || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
        }
        if (n.localName === "template") strip(n.content);
      });
    };
    strip(clone);

    // 3. Styles: replace every <style>/<link> with the CSSOM's view of it, in order.
    clone.querySelectorAll('style, link[rel~="stylesheet"]').forEach((n) => {
      if (!n.closest("template")) n.remove();
    });
    const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
    const sheets = [...d.styleSheets, ...(d.adoptedStyleSheets || [])];
    const styleNodes = [];
    for (const sheet of sheets) {
      if (sheet.disabled) continue;
      const node = sheet.ownerNode;
      if (node && node.closest && node.closest(`#${HOST_ID}`)) continue;
      const links = [];
      const text = sheetText(sheet, links, pageBase);
      const media = sheet.media && sheet.media.mediaText;
      for (const l of links) styleNodes.push({ link: l.href, media: l.media });
      if (text == null) {
        if (sheet.href) styleNodes.push({ link: sheet.href, media });
      } else {
        styleNodes.push({ css: freezeViewportUnits(await inlineCssUrls(text, pageBase)), media });
      }
    }
    for (const s of styleNodes) {
      let el;
      if (s.link) {
        el = document.createElement("link");
        el.rel = "stylesheet";
        el.href = s.link;
      } else {
        el = document.createElement("style");
        el.textContent = s.css;
      }
      if (s.media) el.media = s.media;
      head.appendChild(el);
    }

    // 4. Inline images and style="url(...)" so the snapshot survives the dev server stopping.
    await Promise.all([
      ...[...clone.querySelectorAll("img[src], input[type=image][src]")].map(async (img) => {
        img.setAttribute("src", await inlineAsset(abs(img.getAttribute("src"), pageBase)));
      }),
      ...[...clone.querySelectorAll("video[poster]")].map(async (v) => {
        v.setAttribute("poster", await inlineAsset(abs(v.getAttribute("poster"), pageBase)));
      }),
      ...[...clone.querySelectorAll('[style*="url("]')].map(async (n) => {
        n.setAttribute("style", await inlineCssUrls(n.getAttribute("style"), pageBase));
      }),
    ]);

    for (const n of clone.querySelectorAll("[style]")) {
      const v = n.getAttribute("style");
      if (/v(h|min|max)\b/i.test(v)) n.setAttribute("style", freezeViewportUnits(v));
    }

    // 5. Anything left relative resolves against the original page.
    const base = document.createElement("base");
    base.href = pageBase;
    head.prepend(base);
    if (!head.querySelector("meta[charset]")) {
      const meta = document.createElement("meta");
      meta.setAttribute("charset", "utf-8");
      head.prepend(meta);
    }

    const dt = d.doctype;
    const doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>`
      : "";
    return doctype + "\n" + clone.outerHTML;
  }

  // ---------------------------------------------------------------- toolbar

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;left:0;top:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  // Figma-flavoured: a dark floating pill, the relay mark, a borderless name field,
  // Figma's blue for the primary action, and an icon button for the canvas.
  root.innerHTML = `
    <style>
      :host { --bg: #2c2c2c; --fg: #ffffff; --muted: #ffffff80; --hover: #ffffff14; --blue: #0d99ff; }
      * { box-sizing: border-box; margin: 0; font: 500 12px/1 "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.005em; }
      /* Figma UI3's dark tool bar: 40px controls with 8px corners, hairline dividers,
         recessed fields, Figma blue for the main action. */
      .bar { display: flex; align-items: center; gap: 4px; padding: 6px; background: var(--bg); color: var(--fg);
        border-radius: 14px; box-shadow: 0 0 0 0.5px #00000080, inset 0 0 0 0.5px #ffffff14, 0 2px 6px #00000026, 0 10px 28px #00000040; }
      button, a { height: 38px; border: 0; border-radius: 8px; background: transparent; color: var(--fg); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; white-space: nowrap;
        transition: background 140ms; }
      button:hover, a:hover { background: var(--hover); }
      svg { width: 20px; height: 20px; flex: none; }
      .grip { width: 24px; height: 38px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted);
        border-radius: 6px; cursor: grab; touch-action: none; transition: color 140ms, background 140ms; }
      .grip:hover { color: var(--fg); background: #ffffff0d; }
      .grip svg { width: 18px; height: 18px; }
      :host(.dragging) .grip { cursor: grabbing; }
      input { height: 38px; width: 180px; padding: 0 12px; margin: 0 4px; border: 0; border-radius: 8px; outline: none;
        background: #383838; color: var(--fg); font-size: 12px; transition: background 140ms, box-shadow 140ms; }
      input:hover { background: #3e3e3e; }
      input:focus { background: #383838; box-shadow: inset 0 0 0 1px var(--blue); }
      input::placeholder { color: var(--muted); }
      .snap { background: var(--blue); }
      .snap:hover { background: #0b88e2; }
      /* Tooltips: shown after a short hover, on the side facing the middle of the screen. */
      .tip { position: absolute; bottom: calc(100% + 9px); left: 0; padding: 6px 9px; border-radius: 6px; white-space: nowrap;
        background: #1e1e1e; color: #ffffffeb; font-size: 11px; font-weight: 400; line-height: 1.2; letter-spacing: 0.01em;
        box-shadow: 0 0 0 0.5px #ffffff14 inset, 0 4px 12px #00000040;
        opacity: 0; transform: translate(-50%, 2px); transition: opacity 120ms, transform 120ms; pointer-events: none; }
      .tip.show { opacity: 1; transform: translate(-50%, 0); }
      .tip::after { content: ""; position: absolute; left: 50%; top: 100%; width: 10px; height: 5px; transform: translateX(-50%);
        background: #1e1e1e; clip-path: polygon(0 0, 100% 0, 50% 100%); }
      .tip kbd { margin-left: 8px; font: inherit; color: #ffffff73; }
      /* Docked in a top corner: tooltip below the bar, tail pointing up. */
      :host([data-corner^="top"]) .tip { bottom: auto; top: calc(100% + 9px); transform: translate(-50%, -2px); }
      :host([data-corner^="top"]) .tip.show { transform: translate(-50%, 0); }
      :host([data-corner^="top"]) .tip::after { top: auto; bottom: 100%; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
      .icon { width: 38px; }
      .canvas-link { background: #383838; }
      .canvas-link:hover { background: #444444; }
      button:disabled { opacity: .6; cursor: progress; }
      .sep { align-self: stretch; width: 1px; margin: -6px 4px; background: #ffffff1f; }
      /* The toast sits on the side of the bar facing the middle of the screen. */
      :host([data-corner^="top"]) .toast { bottom: auto; top: calc(100% + 8px); transform: translateY(-4px); }
      :host([data-corner^="top"]) .toast.show { transform: none; }
      :host([data-corner$="left"]) .toast { right: auto; left: 0; }
      .toast { position: absolute; right: 0; bottom: calc(100% + 8px); padding: 8px 10px; border-radius: 8px;
        background: var(--bg); color: var(--fg); box-shadow: 0 0 0 0.5px #ffffff1f inset, 0 4px 14px #00000040; white-space: nowrap;
        opacity: 0; transform: translateY(4px); transition: opacity 250ms, transform 250ms; pointer-events: none; }
      .toast.show { opacity: 1; transform: none; }
      .toast.err { color: #ffb4b4; }
    </style>
    <div class="toast" part="toast"></div>
    <div class="tip" role="tooltip"></div>
    <div class="bar">
      <span class="grip" aria-label="Move the toolbar" role="button" tabindex="-1">
        <!-- Lucide: grip-vertical -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" />
          <circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" />
        </svg>
      </span>
      <span class="sep"></span>
      <input placeholder="Name this state" aria-label="Snapshot name (optional)" />
      <button class="icon snap" aria-label="Snap this page state" data-tip="Snap" data-key="⌥⇧S">
        <!-- Lucide: camera -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </button>
      <a class="icon canvas-link" href="${SERVER}/" target="${CANVAS_TAB}" aria-label="Open the canvas" data-tip="Open canvas">
        <!-- Lucide: square-arrow-out-up-right -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
          <path d="m21 3-9 9" />
          <path d="M15 3h6v6" />
        </svg>
      </a>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const bar = $(".bar");
  const label = $("input");
  const snapBtn = $(".snap");
  const toast = $(".toast");

  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  // Drag the grip anywhere; on release the toolbar snaps to the nearest corner,
  // which is remembered for this site.
  const MARGIN = 16;
  const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const place = (corner, animate) => {
    const { width, height } = host.getBoundingClientRect();
    const left = corner.endsWith("left") ? MARGIN : innerWidth - width - MARGIN;
    const top = corner.startsWith("top") ? MARGIN : innerHeight - height - MARGIN;
    host.style.transition = animate ? "left 280ms cubic-bezier(.2,.8,.2,1), top 280ms cubic-bezier(.2,.8,.2,1)" : "none";
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.dataset.corner = corner;
  };
  let corner = CORNERS.includes(store.get("relay:corner")) ? store.get("relay:corner") : "bottom-right";
  addEventListener("resize", () => place(corner, false));

  const grip = $(".grip");
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = host.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    host.classList.add("dragging");
    host.style.transition = "none";

    // While dragging, a full-screen layer inside the toolbar catches every move and
    // release, even over iframes or other things that would otherwise swallow them.
    const shield = document.createElement("div");
    shield.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:grabbing;background:transparent";
    root.appendChild(shield);

    // Recent pointer positions, to measure the throw's velocity on release.
    const trail = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    trail.start = { x: e.clientX, y: e.clientY };
    const last = () => trail[trail.length - 1];

    const move = (ev) => {
      if (ev.pointerType === "mouse" && !(ev.buttons & 1)) return finish(ev); // the release was missed
      host.style.left = `${ev.clientX - dx}px`;
      host.style.top = `${ev.clientY - dy}px`;
      trail.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
      while (trail.length > 2 && ev.timeStamp - trail[0].t > 100) trail.shift();
    };

    let done = false;
    const finish = (ev) => {
      if (done) return; // several signals can end a drag; only the first counts
      done = true;
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", finish, true);
      removeEventListener("pointercancel", finish, true);
      removeEventListener("blur", finish);
      shield.remove();
      host.classList.remove("dragging");

      // Carry the throw: project where the release velocity would take the grip
      // (like flicking a picture-in-picture window), then take the nearest corner.
      const end = ev && "clientX" in ev ? { x: ev.clientX, y: ev.clientY, t: ev.timeStamp } : last();
      const first = trail[0];
      const dt = Math.max(end.t - first.t, 1);
      const recent = end.t - last().t < 80; // held still before letting go = no throw
      const vx = recent ? (end.x - first.x) / dt : 0; // px per ms
      const vy = recent ? (end.y - first.y) / dt : 0;
      const THROW = 300; // ms of momentum
      const px = end.x + vx * THROW;
      const py = end.y + vy * THROW;
      // A direction you barely moved in keeps its current side (a straight flick up
      // from bottom-right lands top-right, not wherever the grip happens to be).
      const MOVED = 48;
      const [vSide, hSide] = corner.split("-");
      const v = Math.abs(py - trail.start.y) < MOVED ? vSide : py < innerHeight / 2 ? "top" : "bottom";
      const h = Math.abs(px - trail.start.x) < MOVED ? hSide : px < innerWidth / 2 ? "left" : "right";
      corner = `${v}-${h}`;
      store.set("relay:corner", corner);
      place(corner, true);
    };

    // Listen on the whole window, in the capture phase, so a release anywhere ends it.
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", finish, true);
    addEventListener("pointercancel", finish, true);
    addEventListener("blur", finish); // switched windows mid-drag
  });

  let toastTimer;
  const say = (msg, err = false) => {
    toast.textContent = msg;
    toast.classList.toggle("err", err);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  };

  let busy = false;
  async function snap() {
    if (busy) return;
    busy = true;
    snapBtn.disabled = true;
    say("Snapping…");
    try {
      const html = await capture();
      const meta = {
        url: location.href,
        title: document.title,
        label: label.value.trim(),
        viewport: { w: innerWidth, h: innerHeight },
        scroll: { x: scrollX, y: scrollY },
        docHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      };
      const res = await fetch(`${SERVER}/api/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, meta }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      label.value = "";
      say(`Snapped ✓  ${(html.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      say(`Snapshot failed: ${e.message || e}`, true);
      console.error("[relay]", e);
    } finally {
      busy = false;
      snapBtn.disabled = false;
    }
  }

  snapBtn.addEventListener("click", snap);

  // Delayed tooltips for the icon controls.
  const tip = $(".tip");
  let tipTimer;
  const hideTip = () => {
    clearTimeout(tipTimer);
    tip.classList.remove("show");
  };
  for (const el of root.querySelectorAll("[data-tip]")) {
    el.addEventListener("pointerenter", () => {
      if (host.classList.contains("dragging")) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        tip.replaceChildren(el.dataset.tip, ...(el.dataset.key ? [Object.assign(document.createElement("kbd"), { textContent: el.dataset.key })] : []));
        tip.style.left = `${el.offsetLeft + el.offsetWidth / 2}px`;
        tip.classList.add("show");
      }, 400);
    });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("pointerdown", hideTip);
  }

  // Switch to the canvas tab if it's already open instead of opening another one.
  $(".canvas-link").addEventListener("click", (e) => {
    e.preventDefault();
    const tab = window.open("", CANVAS_TAB); // finds the open canvas tab, or opens a blank one
    if (!tab) return void window.open(`${SERVER}/`, "_blank"); // popup blocked: plain new tab
    let blank = true;
    try {
      blank = tab.location.href === "about:blank";
    } catch {
      blank = false; // cross-origin, so it's the canvas that's already open
    }
    if (blank) tab.location.replace(`${SERVER}/`);
    tab.focus();
  });
  label.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") snap();
  });
  addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && e.shiftKey && e.code === "KeyS") {
        e.preventDefault();
        snap();
      }
    },
    true,
  );

  // `/relay off` broadcasts "off"; take the toolbar down without waiting for a reload.
  try {
    const events = new EventSource(`${SERVER}/api/events`);
    events.addEventListener("off", () => {
      host.remove();
      events.close();
      window.__relay = false;
      delete window.relay;
    });
    events.onerror = () => events.close(); // relay stopped; don't keep retrying
  } catch {}

  const mount = () => {
    document.body.appendChild(host);
    place(corner, false);
  };
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);

  window.relay = { snap, capture };
})();
