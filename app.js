// Renders site/digest.json into the page and handles tabs, search and filters.
//
// Item HTML is inserted with innerHTML. It is NOT sanitized: it comes from
// parse_digest.py rendering two markdown files that live in this repo, so the
// input is as trusted as the page itself. Pointing this at anything fetched
// from elsewhere would need sanitizing first.
//
// Reading model: every item collapses to its headline (a native <details>), and
// only runs newer than your last visit start open. Filters and search open
// whatever they match, and clearing them puts the default view back.

const STATUS_LABEL = {
  verified: "Verified",
  reported: "Reported",
  "single-source": "Single source",
  unconfirmed: "Unconfirmed",
};

// Display order for the topic chips; a category missing here sorts last. A feed's
// own meta.topics (from feeds.toml) replaces this when present.
let TOPIC_LABEL = {
  releases: "Releases",
  tips: "Techniques",
  setups: "Setups",
  builds: "Builds",
  reading: "Reading",
  ideas: "Ideas",
  unverified: "Unverified claims",
  meta: "Sub triage",
  other: "Other",
};

const $ = (sel) => document.querySelector(sel);

const panels = { digest: $("#panel-digest"), tips: $("#panel-tips") };
const searchInput = $("#search");
const countEl = $("#count");
const emptyEl = $("#empty");
const topicBox = $("#topic-filters");
const expandBtn = $("#expand-toggle");

const state = {
  tab: "digest",
  query: "",
  statuses: new Set(),
  topics: new Set(),
  expandAll: false,
  cutoff: null, // items dated after this are "new"
};

/* --------------------------------------------------------------- storage */

// Storage can be blocked (private windows, file://); the page must still work.
const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* no-op */ } },
};

// lastSeen survives across visits; the value captured at the start of this
// browser session decides what counts as new, so reloads don't clear the marks.
// Keys carry the feed name: every Pages site shares the awong-pepperoni.github.io
// origin, so un-namespaced keys would let one feed's visit clear another's marks.
function previousVisit(latest, feed) {
  const seenKey = `lastSeen:${feed}`;
  const prevKey = `prevSeen:${feed}`;
  let prev = store.get("sessionStorage", prevKey);
  if (prev === null) {
    // The AI site predates namespacing; carry its old key over once.
    prev = store.get("localStorage", seenKey) ??
      (feed === "ai" ? store.get("localStorage", "lastSeen") : null) ?? "";
    store.set("sessionStorage", prevKey, prev);
  }
  if (latest) store.set("localStorage", seenKey, latest);
  return prev || null;
}

// Per-feed text from feeds.toml. The HTML ships the AI feed's text as a fallback.
function applyMeta(meta) {
  if (!meta) return;
  if (meta.title) {
    document.title = meta.title;
    $(".brand").textContent = meta.title;
  }
  if (meta.tagline) $(".tagline").textContent = meta.tagline;
  if (meta.about) $("#about-text").textContent = meta.about;
  if (meta.durable_label) $("#tab-tips").textContent = meta.durable_label;
  if (meta.topics && Object.keys(meta.topics).length) TOPIC_LABEL = meta.topics;
  if (meta.source_note) $("#source-note").textContent = meta.source_note;
}

/* ------------------------------------------------------------------ build */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function pill(text, kind) {
  return el("span", `pill pill-${kind}`, text);
}

// "Must know" is the 1–3 stories per run the skills flag as essential reading. Its
// cards stay open and its section is highlighted, so it can't be skimmed past.
const MUST_KNOW = "mustknow";

const COVERAGE = "coverage";

// A tracker entry's date: "Due 31 Oct", or "Overdue · 31 Oct" once it has passed.
function duePill(due, label) {
  const day = new Date(`${due}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const text = day.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const node = day < today ? pill(`Overdue · ${text}`, "overdue") : pill(`Due ${text}`, "due");
  if (label) node.title = label;
  return node;
}

function card(item, category, isTip) {
  const node = el("details", category === MUST_KNOW ? "card card-mustknow" : "card");
  node.open = category === MUST_KNOW;
  node.dataset.status = item.status || "none";
  node.dataset.category = category || "";
  node.dataset.text = (item.text || "").toLowerCase();

  const head = el("summary", "card-head");
  const title = el("span", "card-title");
  title.append(el("span", "card-headline", item.headline || ""));
  // Who reported it, readable without opening the card. The Coverage check is
  // an audit list, so its many links would only be noise here.
  if (item.sources?.length && category !== COVERAGE) {
    const extra = item.sources.length - 3;
    const src = el("span", "card-sources");
    src.textContent = item.sources.slice(0, 3).join(" · ") + (extra > 0 ? ` · +${extra} more` : "");
    title.append(src);
  }
  head.append(title);
  const meta = el("span", "card-meta");
  if (item.due) meta.append(duePill(item.due, item.due_label));
  if (item.status) {
    meta.append(el("span", `badge badge-${item.status}`, STATUS_LABEL[item.status] ?? item.status));
  }
  if (isTip && item.updated && state.cutoff && item.updated > state.cutoff) {
    meta.append(pill(`Updated ${item.updated}`, "new"));
  }
  if (meta.childNodes.length) head.append(meta);
  node.append(head);

  // The headline is usually the body's own bold opening; drop it from the body
  // so the expanded text reads on from the summary instead of repeating it.
  let body = item.html || "";
  if (item.headline && body.startsWith(`<p>${item.headline}`)) {
    body = `<p>${body.slice(3 + item.headline.length).replace(/^\s*[—–-]?\s*/, "")}`
      .replace(/^<p>\s*<\/p>\s*/, "");
  }
  const inner = el("div", "card-inner");
  inner.append(el("div", "card-body", body));

  if (item.status_html) {
    const status = el("div", "status");
    status.append(el("div", "status-note", item.status_html));
    inner.append(status);
  }

  // Wide markdown tables get their own scroll container so the page body
  // never scrolls sideways on a narrow screen.
  inner.querySelectorAll("table").forEach((table) => {
    const scroller = el("div", "table-scroll");
    table.replaceWith(scroller);
    scroller.append(table);
  });

  node.append(inner);
  return node;
}

function section({ heading, category, lead_html, items }, isSub = false, isTip = false) {
  const node = el("section",
    `section${isSub ? " sub" : ""}${category === MUST_KNOW ? " section-mustknow" : ""}`);
  if (category) node.dataset.category = category;

  node.append(el("h3", "section-head", heading));

  const stack = el("div", "section-stack");
  if (lead_html) stack.append(el("div", "section-lead", lead_html));

  const cards = el("div", "cards");
  items.forEach((item) => cards.append(card(item, category, isTip)));
  // The Coverage check is a record of what the run read, not news: folded and muted.
  if (category === COVERAGE) {
    node.classList.add("section-coverage");
    const fold = el("details", "coverage-fold");
    fold.append(el("summary", "coverage-toggle", `What this run checked · ${items.length} notes`));
    fold.append(cards);
    stack.append(fold);
  } else {
    stack.append(cards);
  }
  node.append(stack);

  return node;
}

function renderDigest(entries) {
  const frag = document.createDocumentFragment();
  entries.forEach((entry, i) => {
    const isNew = state.cutoff ? entry.date > state.cutoff : i === 0;
    const article = el("details", "entry");
    article.dataset.default = isNew || i === 0 ? "open" : "";
    article.open = article.dataset.default === "open";

    const n = entry.sections.reduce((sum, s) => sum + s.items.length, 0);
    const head = el("summary", "entry-head");
    head.append(el("h2", "entry-date", entry.date));
    head.append(el("span", "entry-title", `${entry.title} · ${n} items`));
    if (isNew && state.cutoff) head.append(pill("New", "new"));
    article.append(head);

    const inner = el("div", "entry-inner");
    if (entry.intro_html) inner.append(el("div", "entry-intro", entry.intro_html));
    entry.sections.forEach((s) => inner.append(section(s)));
    article.append(inner);
    frag.append(article);
  });
  panels.digest.append(frag);
}

function renderTips(themes, heading = "Curated tips") {
  const article = el("article", "entry entry-static");
  const head = el("header", "entry-head");
  head.append(el("h2", "entry-date", heading));
  head.append(el("span", "entry-title", "deduplicated, kept current"));
  article.append(head);

  themes.forEach((theme) => {
    article.append(
      section(
        { heading: theme.theme, category: "tips", lead_html: theme.lead_html, items: theme.items },
        theme.sub,
        true
      )
    );
  });
  panels.tips.append(article);
}

function renderTopics(entries) {
  const present = new Set(entries.flatMap((e) => e.sections.map((s) => s.category)));
  const order = Object.keys(TOPIC_LABEL);
  [...present]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .forEach((key) => {
      const chip = el("button", "chip", TOPIC_LABEL[key] ?? key);
      chip.type = "button";
      chip.dataset.topic = key;
      chip.setAttribute("aria-pressed", "false");
      topicBox.append(chip);
    });
}

/* -------------------------------------------------------------- highlight */

// Wrap query matches in <mark>. Each card keeps its pristine HTML so a new
// query always starts from the original rather than from the last highlight.
function highlight(cardEl, query) {
  cardEl.querySelectorAll(".card-headline, .card-body").forEach((node) => {
    node.dataset.orig ??= node.innerHTML;
    node.innerHTML = node.dataset.orig;
    if (!query) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.toLowerCase().includes(query)) hits.push(walker.currentNode);
    }
    hits.forEach((text) => {
      const frag = document.createDocumentFragment();
      const value = text.nodeValue;
      const lower = value.toLowerCase();
      let at = 0;
      for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, at)) {
        frag.append(value.slice(at, i), el("mark", null, null));
        frag.lastChild.textContent = value.slice(i, i + query.length);
        at = i + query.length;
      }
      frag.append(value.slice(at));
      text.replaceWith(frag);
    });
  });
}

/* ----------------------------------------------------------------- filter */

function matches(cardEl) {
  if (state.query && !cardEl.dataset.text.includes(state.query)) return false;
  if (state.statuses.size && !state.statuses.has(cardEl.dataset.status)) return false;
  if (state.tab === "digest" && state.topics.size && !state.topics.has(cardEl.dataset.category)) {
    return false;
  }
  return true;
}

function apply() {
  const panel = panels[state.tab];
  const filtering = Boolean(state.query || state.statuses.size ||
    (state.tab === "digest" && state.topics.size));
  let shown = 0;
  let total = 0;

  panel.querySelectorAll(".card").forEach((c) => {
    total += 1;
    const ok = matches(c);
    c.hidden = !ok;
    if (ok) shown += 1;
    highlight(c, ok ? state.query : "");
    // A search hit may sit in the body, so open it; otherwise follow the toggle.
    c.open = (ok && Boolean(state.query)) || state.expandAll || c.classList.contains("card-mustknow");
  });

  // Collapse any section, then any entry, left with nothing visible.
  panel.querySelectorAll(".section").forEach((s) => {
    s.hidden = !s.querySelector(".card:not([hidden])");
  });
  // Unfold the Coverage check only when a search or filter is pointing into it.
  panel.querySelectorAll(".coverage-fold").forEach((f) => { f.open = filtering; });
  panel.querySelectorAll(".entry").forEach((e) => {
    e.hidden = !e.querySelector(".section:not([hidden])");
    // Filtering opens every run with a match; clearing restores the default.
    if (e.tagName === "DETAILS") e.open = filtering || state.expandAll || e.dataset.default === "open";
  });

  countEl.textContent = filtering
    ? `Showing ${shown} of ${total} ${total === 1 ? "item" : "items"}`
    : `${total} ${total === 1 ? "item" : "items"}`;
  emptyEl.hidden = shown > 0;
}

function selectTab(name) {
  if (!panels[name]) name = "digest";
  state.tab = name;
  Object.entries(panels).forEach(([key, panel]) => (panel.hidden = key !== name));
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  topicBox.hidden = name !== "digest";
  apply();
}

/* ------------------------------------------------------------------ wire */

function wire() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      history.replaceState(null, "", `#${tab.dataset.tab}`);
      selectTab(tab.dataset.tab);
    });
  });
  // In-page links such as "#tips" (rewritten from tips.md) switch tabs too.
  addEventListener("hashchange", () => {
    selectTab(location.hash.slice(1));
    scrollTo(0, 0);
  });

  let timer;
  searchInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = searchInput.value.trim().toLowerCase();
      apply();
    }, 120);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  const toggleChip = (chip, set, key) => {
    const on = set.has(key);
    on ? set.delete(key) : set.add(key);
    chip.setAttribute("aria-pressed", String(!on));
    apply();
  };
  document.querySelectorAll("#status-filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => toggleChip(chip, state.statuses, chip.dataset.status));
  });
  topicBox.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => toggleChip(chip, state.topics, chip.dataset.topic));
  });

  expandBtn.addEventListener("click", () => {
    state.expandAll = !state.expandAll;
    expandBtn.setAttribute("aria-pressed", String(state.expandAll));
    expandBtn.textContent = state.expandAll ? "Collapse all" : "Expand all";
    apply();
  });

  const root = document.documentElement;
  const toggle = $("#theme-toggle");
  const stored = store.get("localStorage", "theme");
  if (stored === "light" || stored === "dark") root.dataset.theme = stored;
  toggle.addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("localStorage", "theme", root.dataset.theme);
  });

  // Feed the sticky header's real height to the CSS that offsets the rail.
  const header = document.querySelector(".site-header");
  const measure = () =>
    root.style.setProperty("--header-h", `${Math.round(header.offsetHeight)}px`);
  new ResizeObserver(measure).observe(header);
  measure();
}

function showSince(entries, prev) {
  if (!prev || !entries.length) return;
  const fresh = entries.filter((e) => e.date > prev).length;
  const since = $("#since");
  since.textContent = fresh
    ? `${fresh} new ${fresh === 1 ? "run" : "runs"} since your last visit (${prev}).`
    : `Nothing new since your last visit. Latest run: ${entries[0].date}.`;
  since.hidden = false;
}

/* ------------------------------------------------------------------ init */

async function init() {
  // ?feed=<name> previews another feed locally from data/<name>.json; a published
  // site carries exactly one feed as digest.json.
  const param = new URLSearchParams(location.search).get("feed");
  const source = param && /^[a-z0-9_-]+$/.test(param) ? `data/${param}.json` : "digest.json";
  let data;
  try {
    const res = await fetch(source, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (err) {
    // The usual cause is opening index.html over file://, where fetch is blocked.
    emptyEl.hidden = false;
    emptyEl.textContent =
      `Could not load ${source} (${err.message}). Run the parser, then serve this ` +
      `folder over http rather than opening the file directly.`;
    return;
  }

  applyMeta(data.meta);
  const entries = data.digests || [];
  const prev = previousVisit(entries[0]?.date, data.meta?.feed ?? "ai");
  // First visit: treat the latest run as the new one, measured from the run before it.
  state.cutoff = prev ?? entries[1]?.date ?? null;

  renderDigest(entries);
  renderTips(data.tips || [], data.meta?.durable_heading);
  renderTopics(entries);
  showSince(entries, prev);
  $("#generated").textContent = data.generated ?? "unknown";

  wire();
  selectTab(location.hash.slice(1) || "digest");
}

init();
