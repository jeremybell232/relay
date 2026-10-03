// A small checklist app to try relay on: several lists, filters, a detail
// drawer and empty states give plenty of page states worth snapshotting.

const KEY = "checklists-demo";
const today = new Date().toISOString().slice(0, 10);

const seed = () => ({
  lists: [
    {
      id: "groceries",
      title: "Groceries",
      items: [
        { id: "g1", text: "Oat milk", done: true },
        { id: "g2", text: "Sourdough loaf", done: false, priority: "High" },
        { id: "g3", text: "Lemons", done: false },
        { id: "g4", text: "Coffee beans", done: false, due: today, notes: "The light roast from the corner shop" },
        { id: "g5", text: "Basil", done: true },
      ],
    },
    {
      id: "trip",
      title: "Trip prep",
      items: [
        { id: "t1", text: "Book train tickets", done: true },
        { id: "t2", text: "Renew passport", done: false, priority: "High", due: "2026-01-15" },
        { id: "t3", text: "Pack chargers", done: false },
      ],
    },
    { id: "weekend", title: "Weekend", items: [] },
  ],
});

let state = load();
let filter = "all";
let selected = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || seed();
  } catch {
    return seed();
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 8);
const currentList = () => state.lists.find((l) => l.id === (location.hash.slice(2) || state.lists[0]?.id)) || state.lists[0];
const currentItem = () => currentList()?.items.find((i) => i.id === selected);

function render() {
  const list = currentList();

  $("#lists").innerHTML = state.lists
    .map((l) => {
      const open = l.items.filter((i) => !i.done).length;
      return `<a href="#/${l.id}" class="${l === list ? "active" : ""}">${esc(l.title)}<span class="count">${open || ""}</span></a>`;
    })
    .join("");

  const done = list.items.filter((i) => i.done).length;
  $("#title").textContent = list.title;
  $("#summary").textContent = list.items.length ? `${done} of ${list.items.length} done` : "Nothing here yet";
  $("#bar").style.width = list.items.length ? `${(done / list.items.length) * 100}%` : "0";
  document.title = `${list.title} · Checklists`;

  document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.filter === filter)));
  $("#clear").hidden = !done;

  const shown = list.items.filter((i) => filter === "all" || (filter === "done") === i.done);
  $("#items").innerHTML = shown
    .map((i) => {
      const tags = [
        i.priority === "High" ? `<span class="tag high">High</span>` : i.priority ? `<span class="tag">${i.priority}</span>` : "",
        i.due ? `<span class="tag ${!i.done && i.due < today ? "overdue" : ""}">${i.due === today ? "Today" : i.due}</span>` : "",
      ].join("");
      return `<li class="item ${i.done ? "done" : ""} ${i.id === selected ? "selected" : ""}" data-id="${i.id}">
        <input type="checkbox" ${i.done ? "checked" : ""} aria-label="Done" />
        <span class="text">${esc(i.text)}</span>${tags}</li>`;
    })
    .join("");

  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  empty.innerHTML = !list.items.length
    ? `<strong>This list is empty</strong>Add your first item above.`
    : filter === "done"
      ? `<strong>Nothing done yet</strong>Tick something off.`
      : `<strong>All done 🎉</strong>Every item on this list is complete.`;

  const item = currentItem();
  $("#drawer").hidden = !item;
  if (item) {
    $("#d-text").value = item.text;
    $("#d-due").value = item.due || "";
    $("#d-priority").value = item.priority || "";
    $("#d-notes").value = item.notes || "";
  }
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const update = () => (save(), render());

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
  if (!text) return;
  currentList().items.push({ id: uid(), text, done: false });
  e.target.reset();
  update();
});

$("#new-list").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = e.target.title.value.trim();
  if (!title) return;
  const id = uid();
  state.lists.push({ id, title, items: [] });
  e.target.reset();
  save();
  location.hash = `#/${id}`;
});

$("#items").addEventListener("click", (e) => {
  const li = e.target.closest(".item");
  if (!li) return;
  const item = currentList().items.find((i) => i.id === li.dataset.id);
  if (e.target.matches("input[type=checkbox]")) item.done = e.target.checked;
  else selected = selected === item.id ? null : item.id;
  update();
});

document.querySelectorAll("[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    render();
  }),
);

$("#clear").addEventListener("click", () => {
  const list = currentList();
  list.items = list.items.filter((i) => !i.done);
  update();
});

for (const [id, key] of [["#d-text", "text"], ["#d-due", "due"], ["#d-priority", "priority"], ["#d-notes", "notes"]]) {
  $(id).addEventListener("input", (e) => {
    const item = currentItem();
    if (!item) return;
    item[key] = e.target.value;
    save();
    // Re-render, then hand focus back to the field being typed in.
    const active = document.activeElement;
    render();
    active?.focus();
  });
}

$("#d-delete").addEventListener("click", () => {
  const list = currentList();
  list.items = list.items.filter((i) => i.id !== selected);
  selected = null;
  update();
});
$("#close").addEventListener("click", () => {
  selected = null;
  render();
});
$("#reset").addEventListener("click", () => {
  state = seed();
  selected = null;
  filter = "all";
  update();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selected) {
    selected = null;
    render();
  }
});
addEventListener("hashchange", () => {
  selected = null;
  render();
});

render();
