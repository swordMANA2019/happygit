(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const logEl = $("log"), inputEl = $("input"), sendBtn = $("send");
  const modelEl = $("model"), modeEl = $("mode"), statusEl = $("status");
  const reposEl = $("repos"), hintsEl = $("hints"), resizeEl = $("resize");
  const MAX_NODES = 2500;
  const freshAnsi = () => ({ fg: 0, bg: 0, bold: false, dim: false });

  /* ---------- 每个对话一块独立的视图 ---------- */
  const views = new Map();       // chat id -> view
  let infos = [];                // 服务器给的对话摘要（侧边栏的数据来源）
  let repos = [];                // 仓库目录（含还没有对话的）
  let models = [];               // 环境里配置过的模型 { id, backend }
  let active = sessionStorage.getItem("ma-active") || null;
  let pendingSwitch = null;      // 刚创建的对话：等它出现在列表里就切过去
  let removedCwd = null;
  let connected = false;

  const infoOf = (id) => infos.find((i) => i.id === id);
  const activeView = () => (active ? views.get(active) : undefined);

  function view(id) {
    let v = views.get(id);
    if (!v) {
      const el = document.createElement("div");
      el.className = "view";
      el.hidden = id !== active;
      logEl.appendChild(el);
      v = { id, el, current: null, stream: "", ansi: freshAnsi(), asks: new Map(), media: new Set(), busy: false, state: null, stick: true, scrollTop: 0, draft: "", proc: null };
      views.set(id, v);
    }
    return v;
  }

  /* ---------- ANSI -> DOM ---------- */
  function applySgr(v, codes) {
    const a = v.ansi;
    for (const c of codes) {
      if (c === 0) v.ansi = freshAnsi();
      else if (c === 1) a.bold = true;
      else if (c === 2) a.dim = true;
      else if (c === 22) { a.bold = false; a.dim = false; }
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) a.fg = c;
      else if (c === 39) a.fg = 0;
      else if (c >= 40 && c <= 47) a.bg = c;
      else if (c === 49) a.bg = 0;
    }
  }
  function appendAnsi(v, pre, text) {
    const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
    let last = 0, m;
    const put = (s) => {
      if (!s) return;
      const a = v.ansi, cls = [];
      if (a.bold) cls.push("a1");
      if (a.dim) cls.push("a2");
      if (a.fg) cls.push("c" + a.fg);
      if (a.bg) cls.push("b" + a.bg);
      if (!cls.length) { pre.appendChild(document.createTextNode(s)); return; }
      const span = document.createElement("span");
      span.className = cls.join(" ");
      span.textContent = s;
      pre.appendChild(span);
    };
    while ((m = re.exec(text))) {
      put(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[2] === "m") applySgr(v, m[1] === "" ? [0] : m[1].split(";").map(Number));
    }
    put(text.slice(last));
  }
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  /* ---------- 渲染 ---------- */
  const queue = [];
  let scheduled = false;
  const nearBottom = () => logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 48;
  function enqueue(ev) {
    queue.push(ev);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  }
  function flush() {
    scheduled = false;
    const stick = nearBottom();
    while (queue.length) render(queue.shift());
    for (const v of views.values()) while (v.el.childNodes.length > MAX_NODES) v.el.removeChild(v.el.firstChild);
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  function add(v, el) { finishProc(v); v.el.appendChild(el); v.current = null; return el; }

  /* ---------- ReAct 过程（和 Cursor 一样：一个回合一个可折叠的“过程”块） ----------
   * 收起时只有一行：转圈 + 当前在做什么 + 用时；展开后是时间线——
   *   思考：一段文字在原地流式长出来（不是一个词一条记录）
   *   工具：一行一个调用（图标 + 名称 + 关键参数），点开看完整参数和返回
   * 回合结束后这一行变成 “已处理 · 思考 2 · 工具 3 · 12s”。 */
  const preview = (s, n = 120) => { s = String(s ?? "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  const ARG_KEYS = ["path", "target_file", "file_path", "filePath", "command", "pattern", "query", "url", "glob_pattern"];
  function briefArg(text) {
    let o;
    try { o = JSON.parse(text); } catch { return preview(String(text ?? "").replace(/\s+/g, " "), 90); }
    if (o && typeof o === "object") {
      for (const k of ARG_KEYS) if (typeof o[k] === "string" && o[k]) return preview(o[k].replace(/\s+/g, " "), 90);
      return preview(JSON.stringify(o), 90);
    }
    return preview(String(o), 90);
  }
  const fmtDur = (ms) => (ms < 1000 ? "<1s" : ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m" + String(Math.round((ms % 60000) / 1000)).padStart(2, "0") + "s");
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const runningProcs = new Set();
  setInterval(() => { const now = Date.now(); for (const p of runningProcs) p.dur.textContent = fmtDur(now - p.start); }, 1000);

  function procFor(v, ts) {
    if (v.proc) return v.proc;
    const el = mk("details", "proc running");
    const sum = mk("summary");
    const spin = mk("span", "spin");
    const st = mk("span", "st", "处理中…");
    const dur = mk("span", "dur", "");
    sum.append(spin, st, dur);
    const items = mk("div", "items");
    el.append(sum, items);
    v.el.appendChild(el);
    v.current = null;
    const p = { el, st, dur, items, start: ts || Date.now(), last: ts || Date.now(), tools: 0, thoughts: 0, byId: new Map() };
    v.proc = p;
    runningProcs.add(p);
    p.dur.textContent = fmtDur(Date.now() - p.start);
    return p;
  }

  function newThought(p, ts) {
    const item = mk("div", "item thought live");
    const head = mk("div", "th-head");
    const tdur = mk("span", "tdur", "");
    head.append(mk("span", "ico", "◌"), mk("span", "lbl", "思考"), tdur);
    const body = mk("div", "th-body");
    const text = document.createTextNode("");
    body.appendChild(text);
    item.append(head, body);
    p.items.appendChild(item);
    return { item, body, text, tdur, start: ts || Date.now() };
  }
  function appendThought(t, s) {
    const atBottom = t.body.scrollTop + t.body.clientHeight >= t.body.scrollHeight - 8;
    t.text.appendData(s);
    if (atBottom) t.body.scrollTop = t.body.scrollHeight;
  }
  function finishThought(p, t, ts) {
    t.item.classList.remove("live");
    const d = (ts || Date.now()) - t.start;
    if (d >= 1000) t.tdur.textContent = "用时 " + fmtDur(d);
    p.thoughts++;
  }

  function toolItem(p, ev) {
    const d = mk("details", "item tool running");
    const sum = mk("summary");
    const ico = mk("span", "ico");
    const brief = briefArg(ev.text);
    sum.append(ico, mk("span", "nm", ev.name || "工具"), mk("span", "arg", brief));
    const body = mk("div", "tbody");
    const args = mk("pre", "targs", ev.text || "");
    const res = mk("pre", "tres", "");
    res.hidden = true;
    body.append(args, res);
    d.append(sum, body);
    p.items.appendChild(d);
    p.tools++;
    return { el: d, ico, res, name: ev.name || "工具", brief };
  }

  function onTrace(v, ev, ts) {
    const p = procFor(v, ts);
    p.last = ts || Date.now();
    switch (ev.kind) {
      case "thought": {
        if (ev.id && (ev.append || ev.done)) {
          const key = "t:" + ev.id;
          let t = p.byId.get(key);
          if (!t) { if (ev.done && !ev.text) break; t = newThought(p, ts); p.byId.set(key, t); }
          if (ev.text) appendThought(t, ev.text);
          if (ev.done) { finishThought(p, t, ts); p.st.textContent = "处理中…"; }
          else p.st.textContent = "思考中…";
        } else if (ev.text || ev.detail) {                       // 一次给全的思考（native 后端）
          const t = newThought(p, ts);
          appendThought(t, ev.text || "");
          if (ev.detail) { const det = mk("div", "th-detail", ev.detail); t.item.appendChild(det); }
          finishThought(p, t, ts);
          p.st.textContent = "处理中…";
        }
        break;
      }
      case "action": {
        const t = toolItem(p, ev);
        if (ev.id) p.byId.set("a:" + ev.id, t);
        p.st.textContent = t.name + (t.brief ? " " + t.brief : "");
        break;
      }
      case "observation": {
        let t = ev.id ? p.byId.get("a:" + ev.id) : null;
        if (!t) t = toolItem(p, { name: ev.name, text: "" });
        t.el.classList.remove("running");
        t.el.classList.add(ev.ok === false ? "bad" : "ok");
        t.ico.textContent = ev.ok === false ? "✗" : "✓";
        const txt = String(ev.text ?? "").trim();
        if (txt && txt !== "completed" && txt !== "error") { t.res.textContent = txt; t.res.hidden = false; }
        p.st.textContent = "处理中…";
        break;
      }
      case "plan": {
        const item = mk("div", "item plan");
        item.append(mk("div", "th-head", "计划"), mk("div", "th-body", ev.text || ""));
        p.items.appendChild(item);
        break;
      }
    }
  }

  function finishProc(v, ts) {
    const p = v.proc;
    if (!p) return;
    v.proc = null;
    runningProcs.delete(p);
    p.el.classList.remove("running");
    for (const x of p.byId.values()) {                         // 没等到结果的工具 / 没收尾的思考（被中断）
      if (x.el && x.el.classList.contains("running")) { x.el.classList.remove("running"); x.el.classList.add("stopped"); x.ico.textContent = "–"; }
      if (x.item && x.item.classList.contains("live")) finishThought(p, x, ts);
    }
    const parts = [];
    if (p.thoughts) parts.push("思考 " + p.thoughts);
    if (p.tools) parts.push("工具 " + p.tools);
    p.st.textContent = "已处理" + (parts.length ? " · " + parts.join(" · ") : "");
    p.dur.textContent = fmtDur(Math.max(p.last, ts || 0) - p.start);
  }

  const MEDIA_RE = /(?:[A-Za-z]:[\\/])?[^\s"'`<>|*?:()（），。]+\.(png|jpe?g|gif|webp|bmp|mp4|m4v|webm|mov|mp3|wav|ogg|m4a|flac|aac)\b/gi;
  function addMedia(v, text) {
    let n = 0, m;
    MEDIA_RE.lastIndex = 0;
    while ((m = MEDIA_RE.exec(text)) && n < 6) {
      const p = m[0];
      if (v.media.has(p)) continue;
      v.media.add(p);
      const ext = m[1].toLowerCase();
      const src = "/file?p=" + encodeURIComponent(p) + "&chat=" + encodeURIComponent(v.id);
      let el;
      if (/^(mp4|m4v|webm|mov)$/.test(ext)) { el = document.createElement("video"); el.controls = true; el.preload = "metadata"; }
      else if (/^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext)) { el = document.createElement("audio"); el.controls = true; el.preload = "metadata"; }
      else { el = document.createElement("img"); el.loading = "lazy"; }
      const box = document.createElement("div");
      box.className = "media";
      box.hidden = true;                                  // 文件不存在 / 在项目目录之外时服务器返回 404：保持隐藏
      el.addEventListener("error", () => box.remove());
      el.addEventListener(el.tagName === "IMG" ? "load" : "loadedmetadata", () => { box.hidden = false; });
      el.src = src;
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = p;
      box.append(el, cap);
      v.el.appendChild(box);
      v.current = null;
      n++;
    }
  }

  function render(ev) {
    switch (ev.t) {
      case "chats": return applyChats(ev);
      case "removed": return applyRemoved(ev.chat);
      case "bye": {
        for (const v of views.values()) {
          const d = document.createElement("pre");
          d.className = "out notice";
          d.textContent = "已退出。可以关闭这个窗口。";
          add(v, d);
        }
        if (es) es.close();
        setStatus("off");
        return;
      }
    }
    if (!ev.chat) return;
    const v = view(ev.chat);
    switch (ev.t) {
      case "out": {
        if (ev.stream === "err") break;                // 运行日志不进界面（见后端 logs/backend-*.log）
        if (!v.current || v.stream !== ev.stream) {
          finishProc(v, ev.ts);                        // 结果文字出现 = 这一段过程结束，后面的过程另起一块
          v.current = document.createElement("pre");
          v.current.className = "out " + ev.stream;
          v.stream = ev.stream;
          v.ansi = freshAnsi();
          v.el.appendChild(v.current);
        }
        appendAnsi(v, v.current, ev.text);
        if (ev.stream === "out") addMedia(v, stripAnsi(ev.text));
        break;
      }
      case "trace": onTrace(v, ev.ev, ev.ts); break;
      case "user": {
        const d = document.createElement("div");
        d.className = "msg user";
        d.textContent = ev.text;
        add(v, d);
        break;
      }
      case "ask": {
        const card = document.createElement("div");
        card.className = "card ask";
        const q = document.createElement("div");
        q.className = "q";
        q.textContent = stripAnsi(ev.question).trim();
        const row = document.createElement("div");
        row.className = "row";
        const submit = (text) => answer(ev.id, text);
        const re = /\[([A-Za-z])\](\w*)/g;
        let m;
        const seen = new Set();
        while ((m = re.exec(ev.question))) {
          const key = m[1].toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const b = document.createElement("button");
          b.textContent = m[1] + m[2];
          if (key === "y") b.classList.add("primary");
          b.addEventListener("click", () => submit(key));
          row.appendChild(b);
        }
        const inp = document.createElement("input");
        inp.placeholder = "或直接输入回答…";
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(inp.value); });
        const ok = document.createElement("button");
        ok.textContent = "提交";
        ok.addEventListener("click", () => submit(inp.value));
        row.append(inp, ok);
        card.append(q, row);
        v.asks.set(ev.id, card);
        add(v, card);
        if (v.id === active) setTimeout(() => inp.focus({ preventScroll: true }), 0);
        break;
      }
      case "askdone": {
        const card = v.asks.get(ev.id);
        if (card) { card.classList.add("done"); card.querySelectorAll("button,input").forEach((x) => (x.disabled = true)); v.asks.delete(ev.id); }
        break;
      }
      case "diff": {
        const card = document.createElement("div");
        card.className = "card diff";
        const t = document.createElement("div");
        t.className = "title";
        t.textContent = ev.title + "（" + ev.files + " 个文件）";
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.src = "/diff/" + ev.id;
        card.append(t, f);
        add(v, card);
        break;
      }
      case "busy": v.busy = ev.busy; if (!ev.busy) finishProc(v, ev.ts); if (v.id === active) refreshChrome(); break;
      case "state": v.state = ev.state; if (v.id === active) refreshChrome(); break;
    }
  }

  /* ---------- 对话列表 / 侧边栏 ---------- */
  function applyChats(ev) {
    infos = ev.chats; repos = ev.repos; models = ev.models;
    for (const i of infos) view(i.id).busy = i.busy;
    if (pendingSwitch && infoOf(pendingSwitch)) { const id = pendingSwitch; pendingSwitch = null; setActive(id); }
    else if (!active || !infoOf(active)) {
      const near = removedCwd && infos.filter((i) => sameDir(i.cwd, removedCwd)).pop();
      setActive((near || infos[infos.length - 1])?.id ?? null);
    }
    removedCwd = null;
    renderSide();
    refreshChrome();
  }
  function applyRemoved(id) {
    removedCwd = infoOf(id)?.cwd ?? null;
    const v = views.get(id);
    if (v) { v.el.remove(); views.delete(id); }
    if (active === id) active = null;
  }

  const isWinPath = (p) => /^[A-Za-z]:|\\/.test(p);
  const dirKey = (p) => (isWinPath(p) ? p.toLowerCase() : p);
  const sameDir = (a, b) => dirKey(a) === dirKey(b);
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  const FOLDER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  let sideSig = "";
  function renderSide() {
    const groups = new Map();
    const group = (cwd) => {
      const k = dirKey(cwd);
      if (!groups.has(k)) groups.set(k, { cwd, chats: [] });
      return groups.get(k);
    };
    for (const r of repos) group(r);
    for (const i of infos) group(i.cwd).chats.push(i);
    const data = [...groups.values()].map((g) => ({ cwd: g.cwd, chats: g.chats.slice().reverse() }));       // 新的在上
    const sig = JSON.stringify([data, active]);
    if (sig === sideSig) return;
    sideSig = sig;

    reposEl.textContent = "";
    for (const g of data) {
      const box = document.createElement("div");
      box.className = "repo";
      const head = document.createElement("div");
      head.className = "repo-head";
      head.title = g.cwd;
      const folder = document.createElement("span");
      folder.className = "folder";
      folder.innerHTML = FOLDER;
      const name = document.createElement("span");
      name.className = "rname";
      name.textContent = baseName(g.cwd);
      const acts = document.createElement("span");
      acts.className = "acts";
      const plus = document.createElement("button");
      plus.className = "icon-btn"; plus.textContent = "+"; plus.title = "在这个仓库里新建对话";
      plus.addEventListener("click", (e) => { e.stopPropagation(); newChat(g.cwd); });
      const rm = document.createElement("button");
      rm.className = "icon-btn"; rm.textContent = "×"; rm.title = "从列表移除这个仓库（及其对话；不会删除任何文件）";
      rm.addEventListener("click", (e) => { e.stopPropagation(); removeRepo(g.cwd); });
      acts.append(plus, rm);
      head.append(folder, name, acts);
      box.appendChild(head);

      if (!g.chats.length) {
        const e = document.createElement("div");
        e.className = "empty-repo";
        e.textContent = "（没有对话，点 + 新建）";
        box.appendChild(e);
      }
      for (const c of g.chats) {
        const row = document.createElement("div");
        row.className = "chat" + (c.id === active ? " active" : "") + (c.busy ? " busy" : "");
        row.title = c.model + " · " + c.cwd;
        const body = document.createElement("div");
        body.className = "body";
        const t = document.createElement("div");
        t.className = "ctitle" + (c.title ? "" : " untitled");
        t.textContent = c.title || "新对话";
        const m = document.createElement("span");
        m.className = "cmodel";
        m.textContent = c.model;
        body.append(t, m);
        const dot = document.createElement("span");
        dot.className = "dot";
        const close = document.createElement("button");
        close.className = "icon-btn close"; close.textContent = "×"; close.title = "关闭这个对话";
        close.addEventListener("click", (e) => { e.stopPropagation(); post("/api/chat/close", { chat: c.id }); });
        row.append(body, dot, close);
        row.addEventListener("click", () => setActive(c.id));
        box.appendChild(row);
      }
      reposEl.appendChild(box);
    }
  }

  function setActive(id) {
    if (id === active && activeView() && !activeView().el.hidden) { refreshChrome(); return; }
    const old = activeView();
    if (old) { old.draft = inputEl.value; old.scrollTop = logEl.scrollTop; old.stick = nearBottom(); old.el.hidden = true; }
    active = id;
    if (id) sessionStorage.setItem("ma-active", id);
    const v = id ? view(id) : null;
    if (v) {
      v.el.hidden = false;
      inputEl.value = v.draft;
      logEl.scrollTop = v.stick ? logEl.scrollHeight : v.scrollTop;
    } else inputEl.value = "";
    autosize();
    closeHints();
    renderSide();
    refreshChrome();
    inputEl.focus();
  }

  async function newChat(cwd) {
    const base = infoOf(active);
    const r = await post("/api/chat/new", { cwd: cwd || base?.cwd, from: active });
    if (!r.ok) { notice("新建对话失败：" + ((await r.json().catch(() => ({}))).error || r.status)); return; }
    pendingSwitch = (await r.json()).id;
    if (infoOf(pendingSwitch)) { const id = pendingSwitch; pendingSwitch = null; setActive(id); }
  }
  function removeRepo(cwd) {
    if (!confirm("从列表移除仓库 “" + baseName(cwd) + "” 及其所有对话？\n（不会删除任何文件；对话内容可在重新添加后用 /resume 恢复）")) return;
    post("/api/repo/remove", { cwd }).then(async (r) => { if (!r.ok) notice((await r.json().catch(() => ({}))).error || "移除失败"); });
  }

  /* 添加仓库：输入目录，在那里开一个新对话 */
  const addRepoRow = $("addRepoRow"), addRepoInput = $("addRepoInput"), addRepoErr = $("addRepoErr");
  $("addRepo").addEventListener("click", () => {
    addRepoRow.hidden = !addRepoRow.hidden;
    addRepoErr.textContent = "";
    if (!addRepoRow.hidden) addRepoInput.focus();
  });
  addRepoInput.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { addRepoRow.hidden = true; inputEl.focus(); return; }
    if (e.key !== "Enter" || e.isComposing) return;
    const cwd = addRepoInput.value.trim();
    if (!cwd) return;
    const r = await post("/api/chat/new", { cwd, from: active });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { addRepoErr.textContent = body.error || "失败：" + r.status; return; }
    addRepoInput.value = ""; addRepoRow.hidden = true;
    pendingSwitch = body.id;
    if (infoOf(pendingSwitch)) { const id = pendingSwitch; pendingSwitch = null; setActive(id); }
  });
  $("newChat").addEventListener("click", () => newChat());

  /* ---------- 状态 / 标题栏 ---------- */
  function setStatus(kind) {
    statusEl.className = "status" + (kind === "on" ? " on" : kind === "busy" ? " busy" : "");
    statusEl.title = kind === "off" ? "已断开" : kind === "busy" ? "任务运行中" : "已连接";
  }
  function fillModelSelect() {
    const sig = JSON.stringify(models);
    if (modelEl.dataset.sig !== sig) {
      modelEl.dataset.sig = sig;
      const cur = modelEl.value;
      modelEl.textContent = "";
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.id;
        o.title = m.backend === "cursor" ? "Cursor Agent" : "OpenAI 兼容";
        modelEl.appendChild(o);
      }
      if (cur) modelEl.value = cur;
    }
  }
  function refreshChrome() {
    const v = activeView(), info = active ? infoOf(active) : undefined;
    const busy = Boolean(v && v.busy);
    sendBtn.textContent = busy ? "停止" : "发送";
    sendBtn.classList.toggle("danger", busy);
    sendBtn.disabled = !active;
    inputEl.placeholder = busy ? "任务运行中…（点“停止”中断；可切换到别的对话）" : "输入任务，回车发送，Shift+回车换行；输入 / 查看命令，Tab 补全";
    setStatus(!connected ? "off" : busy ? "busy" : "on");

    const model = (v?.state?.model) || info?.model || "";
    fillModelSelect();
    if (document.activeElement !== modelEl && model) {
      if ([...modelEl.options].some((o) => o.value === model)) modelEl.value = model;
      else if (model) { const o = document.createElement("option"); o.value = model; o.textContent = model; modelEl.appendChild(o); modelEl.value = model; }
    }
    modelEl.disabled = !info || busy;
    // document.title = "Mini Agent";
    if (info) $("pane").title = (info.title || "新对话") + "\n" + info.cwd + (info.model ? "\n模型：" + info.model : "");
    else $("pane").title = "";
  }

  /* ---------- 发送 ---------- */
  async function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  function notice(text) {
    const v = activeView();
    if (!v) return;
    const d = document.createElement("pre");
    d.className = "out notice";
    d.textContent = text;
    add(v, d);
    logEl.scrollTop = logEl.scrollHeight;
  }
  async function submitText(text) {
    text = text.trim();
    if (!text || !active) return false;
    const v = activeView();
    if (v && v.busy) { notice("这个对话上一个任务还在运行，请等它结束或点“中断”。"); return false; }
    const r = await post("/api/input", { text, chat: active });
    if (r.status === 409) { notice("这个对话上一个任务还在运行。"); return false; }
    if (!r.ok) { notice("发送失败：" + r.status); return false; }
    return true;
  }
  const history = JSON.parse(sessionStorage.getItem("ma-history") || "[]");
  let histPos = -1;
  async function send() {
    const raw = inputEl.value;
    if (!raw.trim()) return;
    const text = raw.trim().startsWith("/") ? raw : modeEl.value + raw;
    if (await submitText(text)) {
      history.push(raw);
      if (history.length > 100) history.shift();
      sessionStorage.setItem("ma-history", JSON.stringify(history));
      histPos = -1;
      inputEl.value = "";
      autosize();
      closeHints();
    }
  }
  async function answer(id, text) {
    const r = await post("/api/answer", { id, text });
    if (!r.ok) notice("回答没有送达（提问可能已结束）。");
  }
  function autosize() {
    inputEl.style.height = "auto";
    const border = inputEl.offsetHeight - inputEl.clientHeight;          // border-box：高度要把边框算进去，否则会冒出多余的滚动条
    inputEl.style.height = Math.min(inputEl.scrollHeight + border, 200) + "px";
  }

  modelEl.addEventListener("change", async () => {
    const model = modelEl.value;
    if (!model || !active || model === (infoOf(active)?.model ?? "")) return;
    const r = await post("/api/chat/model", { chat: active, model });
    if (!r.ok) notice("切换模型失败：" + ((await r.json().catch(() => ({}))).error || r.status));
    else inputEl.focus();
  });

  /* ---------- 斜杠命令提示（输入 / 弹出，↑↓ 选择，Tab 补全） ---------- */
  const COMMANDS = [
    { cmd: "/ask", args: "<问题>", desc: "只读问答（不会改文件）" },
    { cmd: "/fix", args: "<任务>", desc: "修复：先跑验证拿到真实报错，再改" },
    { cmd: "/edit", args: "<任务>", desc: "编辑：每处改动逐项确认" },
    { cmd: "/diag", args: "<任务>", desc: "只读诊断，出报告后选择要修的问题" },
    { cmd: "/diff", args: "[print|html|ide|编号]", desc: "查看最近一次任务的改动", opts: () => ["print", "html", "ide", "vim"] },
    { cmd: "/undo", desc: "撤销最近一次任务的所有改动" },
    { cmd: "/plan", desc: "查看计划与笔记" },
    { cmd: "/jobs", desc: "后台任务" },
    { cmd: "/skills", desc: "可用技能" },
    { cmd: "/mcp", args: "[reload]", desc: "外部工具（MCP）连接状态", opts: () => ["reload"] },
    { cmd: "/resume", desc: "恢复这个目录上次的对话" },
    { cmd: "/reset", desc: "清空当前对话" },
    { cmd: "/context", desc: "查看发给模型的上下文" },
    { cmd: "/probe", desc: "重新探测项目" },
    { cmd: "/model", args: "<模型名>", desc: "切换这个对话的模型", opts: () => models.map((m) => m.id) },
    { cmd: "/cd", args: "<目录>", desc: "切换这个对话的工作目录（会清空对话）" },
    { cmd: "/pwd", desc: "显示当前目录" },
    { cmd: "/ppt", args: "[review]", desc: "PowerPoint 状态 / 评审当前页", ppt: true, opts: () => ["review"] },
    { cmd: "/watch", args: "ppt [off]", desc: "实时监视 PowerPoint 并给建议", ppt: true, opts: () => ["ppt", "ppt off"] },
    { cmd: "/apply", args: "[编号]", desc: "执行 PowerPoint 的自动修复", ppt: true },
    { cmd: "/exit", desc: "退出程序" },
  ];
  const optional = (c) => !c.args || c.args.startsWith("[");
  let hintItems = [], hintSel = 0, hintsDismissed = false;

  function computeHints() {
    const val = inputEl.value;
    if (hintsDismissed || !val.startsWith("/") || val.includes("\n")) return [];
    const pptOn = Boolean(activeView()?.state?.ppt);
    const avail = COMMANDS.filter((c) => !c.ppt || pptOn);
    const m = /^(\/\S*)(\s+)?/.exec(val);
    if (!m[2]) {                                            // 还在输命令名
      const low = val.toLowerCase();
      return avail.filter((c) => c.cmd.startsWith(low)).map((c) => ({ c, value: c.args ? c.cmd + " " : c.cmd, pick: true }));
    }
    const c = avail.find((x) => x.cmd === m[1].toLowerCase());
    if (!c) return [];
    const rest = val.slice(m[0].length);
    const options = (c.opts ? c.opts() : []).filter((o) => o.toLowerCase().startsWith(rest.toLowerCase()) && o !== rest);
    if (options.length) return options.map((o) => ({ c, arg: o, value: c.cmd + " " + o, pick: true }));
    if (c.args && rest === "") return [{ c, usage: true, pick: false }];                 // 只提示用法，不抢焦点
    return [];
  }
  function showHints() {
    hintItems = computeHints();
    if (hintSel >= hintItems.length) hintSel = 0;
    hintsEl.textContent = "";
    hintsEl.hidden = hintItems.length === 0;
    if (!hintItems.length) return;
    hintItems.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "hint" + (idx === hintSel && it.pick ? " sel" : "") + (it.pick ? "" : " only");
      const cmd = document.createElement("span");
      cmd.className = "cmd";
      cmd.textContent = it.arg ? it.c.cmd + " " + it.arg : it.c.cmd;
      row.appendChild(cmd);
      if (it.c.args && !it.arg) { const a = document.createElement("span"); a.className = "args"; a.textContent = it.c.args; row.appendChild(a); }
      const d = document.createElement("span");
      d.className = "desc";
      d.textContent = it.c.desc;
      row.appendChild(d);
      if (it.pick) {
        row.addEventListener("mousedown", (e) => { e.preventDefault(); acceptHint(idx); });
        row.addEventListener("mousemove", () => { if (hintSel !== idx) { hintSel = idx; showHints(); } });
      }
      hintsEl.appendChild(row);
    });
    const foot = document.createElement("div");
    foot.className = "hint-foot";
    foot.textContent = hintItems.some((i) => i.pick) ? "↑↓ 选择　Tab 补全　Enter 确认　Esc 关闭" : "输入参数后回车发送";
    hintsEl.appendChild(foot);
    const sel = hintsEl.querySelector(".sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
  function closeHints() { hintItems = []; hintSel = 0; hintsEl.hidden = true; hintsEl.textContent = ""; }
  function acceptHint(idx) {
    const it = hintItems[idx];
    if (!it || !it.pick) return;
    inputEl.value = it.value;
    autosize();
    inputEl.setSelectionRange(it.value.length, it.value.length);
    hintsDismissed = false; hintSel = 0;
    showHints();
    inputEl.focus();
  }
  const hintsOpen = () => !hintsEl.hidden && hintItems.some((i) => i.pick);

  sendBtn.addEventListener("click", () => { if (activeView()?.busy) post("/api/interrupt", { chat: active }); else void send(); });
  inputEl.addEventListener("input", () => { autosize(); hintsDismissed = false; hintSel = 0; showHints(); });
  inputEl.addEventListener("blur", closeHints);
  inputEl.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (hintsOpen()) {
      const picks = hintItems.map((it, i) => (it.pick ? i : -1)).filter((i) => i >= 0);
      const at = picks.indexOf(hintSel);
      if (e.key === "ArrowDown") { hintSel = picks[(at + 1) % picks.length]; showHints(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { hintSel = picks[(at - 1 + picks.length) % picks.length]; showHints(); e.preventDefault(); return; }
      if (e.key === "Tab" && !e.shiftKey) { acceptHint(hintSel); e.preventDefault(); return; }
      if (e.key === "Escape") { hintsDismissed = true; closeHints(); e.preventDefault(); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        const it = hintItems[hintSel], typed = inputEl.value.trim();
        // 已经完整输入了一个不需要参数的命令：直接发送；否则回车 = 补全
        const complete = !it.arg && optional(it.c) && it.c.cmd === typed;
        if (!complete) { acceptHint(hintSel); e.preventDefault(); return; }
      }
    } else if (e.key === "Tab" && !e.shiftKey && inputEl.value.startsWith("/")) {
      e.preventDefault();                                   // 在命令里按 Tab 不要跳走焦点
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === "ArrowUp" && inputEl.selectionStart === 0 && history.length) {
      histPos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      inputEl.value = history[histPos]; e.preventDefault(); autosize();
    } else if (e.key === "ArrowDown" && histPos >= 0) {
      histPos++;
      inputEl.value = histPos >= history.length ? "" : history[histPos];
      if (histPos >= history.length) histPos = -1;
      e.preventDefault(); autosize();
    }
  });

  /* ---------- 事件流 ---------- */
  let es = null;
  function connect() {
    es = new EventSource("/events");
    es.onopen = () => { connected = true; refreshChrome(); };
    es.onerror = () => { connected = false; refreshChrome(); };
    es.addEventListener("reset", () => {      // 每次（重新）连接服务器都会按顺序回放历史：先清空
      for (const v of views.values()) v.el.remove();
      views.clear(); queue.length = 0; infos = []; sideSig = "";
    });
    es.onmessage = (m) => { try { enqueue(JSON.parse(m.data)); } catch { /* 忽略坏数据 */ } };
  }
  /* ---------- 侧边栏宽度拖动 ---------- */
  (function sideResize() {
    const KEY = "ma-side-w";
    const min = 140, max = () => Math.min(560, Math.floor(window.innerWidth * 0.48));
    let w = parseInt(localStorage.getItem(KEY) || "260", 10);
    const apply = () => { w = Math.min(max(), Math.max(min, w)); document.documentElement.style.setProperty("--side-w", w + "px"); };
    apply();
    let drag = false, x0 = 0, w0 = w;
    const move = (e) => { if (!drag) return; w = w0 + (e.clientX - x0); apply(); };
    const up = () => { if (!drag) return; drag = false; resizeEl.classList.remove("dragging"); localStorage.setItem(KEY, String(w)); document.body.style.cursor = ""; document.body.style.userSelect = ""; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    resizeEl.addEventListener("mousedown", (e) => { if (e.button !== 0) return; drag = true; x0 = e.clientX; w0 = w; resizeEl.classList.add("dragging"); document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); e.preventDefault(); });
    window.addEventListener("resize", apply);
  })();

  connect();
  autosize();
  inputEl.focus();
})();
