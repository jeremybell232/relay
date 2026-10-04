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
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { --bg: #18181b; --fg: #fafafa; --muted: #a1a1aa; --line: #3f3f46; --accent: #fafafa; --accent-fg: #18181b; }
      * { box-sizing: border-box; margin: 0; font: 500 13px/1 ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif; }
      .bar { display: flex; align-items: center; gap: 6px; padding: 6px; background: var(--bg); color: var(--fg);
        border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 24px #0004; }
      .brand { display: flex; align-items: center; gap: 6px; padding: 0 6px 0 4px; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 3px #ef444433; }
      input { height: 32px; width: 160px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--line);
        background: transparent; color: var(--fg); outline: none; }
      input:focus { border-color: var(--muted); }
      input::placeholder { color: var(--muted); }
      button, a { height: 32px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent;
        color: var(--fg); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
        transition: background 140ms; white-space: nowrap; }
      button:hover, a:hover { background: #27272a; }
      button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
      button.primary:hover { background: #e4e4e7; }
      button:disabled { opacity: .6; cursor: progress; }
      kbd { font-size: 11px; opacity: .55; }
      .collapsed .hide { display: none; }
      .toast { position: absolute; right: 0; bottom: calc(100% + 8px); padding: 8px 12px; border-radius: 8px;
        background: var(--bg); color: var(--fg); border: 1px solid var(--line); white-space: nowrap;
        opacity: 0; transform: translateY(4px); transition: opacity 250ms, transform 250ms; pointer-events: none; }
      .toast.show { opacity: 1; transform: none; }
      .toast.err { color: #fca5a5; }
    </style>
    <div class="toast" part="toast"></div>
    <div class="bar">
      <span class="brand" title="Collapse / expand relay"><span class="dot"></span><span class="hide">relay</span></span>
      <input class="hide" placeholder="Label (optional)" />
      <button class="primary hide snap" title="Snapshot this page state (⌥⇧S)">Snap <kbd>⌥⇧S</kbd></button>
      <a class="hide canvas-link" href="${SERVER}/" target="${CANVAS_TAB}" title="Open the canvas">Canvas ↗</a>
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
  bar.classList.toggle("collapsed", store.get("relay:collapsed") === "1");
  $(".brand").addEventListener("click", () => {
    bar.classList.toggle("collapsed");
    store.set("relay:collapsed", bar.classList.contains("collapsed") ? "1" : "0");
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

  const mount = () => document.body.appendChild(host);
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);

  window.relay = { snap, capture };
})();
