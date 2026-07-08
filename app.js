const db = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let calendar;

// ---------- утилиты ----------
// Всё время — МСК (UTC+3, без перехода на лето). Стенное время МСК храним как
// UTC-метку и показываем в UTC → у всех одинаковые цифры независимо от их пояса.
const MSK_MS = 3 * 60 * 60 * 1000;
function nowMsk() { return new Date(Date.now() + MSK_MS); } // getUTC* = стенные часы МСК
function pad(n) { return String(n).padStart(2, "0"); }
function dateVal(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function timeVal(d) { return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
function toISO(dateStr, timeStr) { return `${dateStr}T${timeStr}:00.000Z`; } // введённое = МСК
function fmtTime(iso) { return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }); }

// ---------- календарь ----------
document.addEventListener("DOMContentLoaded", () => {
  calendar = new FullCalendar.Calendar(document.getElementById("calendar"), {
    locale: "ru",
    timeZone: "UTC",          // показываем стенное МСК-время (хранится как UTC-метка)
    now: () => nowMsk(),      // «сейчас» тоже в МСК, иначе линия уехала бы на 3ч
    initialView: "timeGridWeek",
    firstDay: 1,
    nowIndicator: true,
    slotEventOverlap: false,  // пересекающиеся не наезжают друг на друга, а стоят колонками
    eventMaxStack: 3,         // максимум 3 рядом, остальное → «+ ещё N» с попапом
    moreLinkClick: "popover", // клик по «+N» открывает список всех встреч слота
    slotMinTime: "07:00:00",
    slotMaxTime: "22:00:00",
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false }, // 07:00 вместо 7
    slotDuration: "01:00:00",
    slotLabelInterval: "01:00:00",
    expandRows: true,
    height: "auto",
    allDaySlot: false,
    dayHeaderFormat: { weekday: "short", day: "numeric", month: "numeric" },
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek" },
    buttonText: { today: "Сегодня", day: "День", week: "Неделя" },
    selectable: true,
    // тянем встречи Supabase только за видимый диапазон
    events: async (info) => {
      const { data, error } = await db
        .from("meetings")
        .select("*")
        .gte("starts_at", info.start.toISOString())
        .lt("starts_at", info.end.toISOString());
      if (error) throw error;
      return data.map(m => ({
        id: m.id,
        title: m.title,
        start: m.starts_at,
        end: m.ends_at,
        extendedProps: { participants: m.participants || [] },
      }));
    },
    // в карточке: название + счётчик, имена сокращаются с «…»
    eventContent: (arg) => {
      const p = arg.event.extendedProps.participants || [];
      return { html:
        `<div class="ev">` +
          `<div class="ev-time">${arg.timeText}</div>` +
          `<div class="ev-title">${escapeHtml(arg.event.title)}` +
            (p.length ? ` <span class="ev-count">· ${p.length} чел</span>` : "") +
          `</div>` +
          (p.length ? `<div class="ev-people">${p.map(escapeHtml).join(", ")}</div>` : "") +
        `</div>` };
    },
    // полный список участников по наведению — влезает любое число имён
    eventDidMount: (info) => {
      const p = info.event.extendedProps.participants || [];
      info.el.title = info.event.title + (p.length ? `\nУчастники: ${p.join(", ")}` : "");
    },
    // клик по пустому слоту → форма с подставленным временем
    select: info => openModal(info.start, info.end),
    // клик по встрече → удалить
    eventClick: async info => {
      if (confirm(`Удалить встречу «${info.event.title}»?`)) {
        await db.from("meetings").delete().eq("id", info.event.id);
        calendar.refetchEvents();
      }
    },
  });
  calendar.render();
});

// ---------- проверка конфликта ----------
// Пересечение интервалов: (startA < endB) && (startB < endA), по каждому участнику.
async function findConflict(startISO, endISO, people) {
  const { data, error } = await db
    .from("meetings")
    .select("*")
    .lt("starts_at", endISO)   // starts_at < newEnd
    .gt("ends_at", startISO);  // ends_at   > newStart
  if (error) throw error;
  for (const m of data) {
    const clash = m.participants.filter(p => people.includes(p));
    if (clash.length) return { meeting: m, people: clash };
  }
  return null;
}
// ponytail: проверка read-then-insert — есть окно гонки при двух одновременных бронированиях.
// Для демо ок. В проде: exclusion-constraint в Postgres или транзакция.

// ---------- создание ----------
async function submit(e) {
  e.preventDefault();
  const f = e.target;
  const errEl = document.getElementById("form-error");
  errEl.classList.add("hidden");

  const people = [...f.querySelectorAll('input[name="p"]:checked')].map(i => i.value);
  if (people.length === 0) return showError(errEl, "Выбери хотя бы одного участника");

  const startISO = toISO(f.date.value, f.start.value);
  const endISO = toISO(f.date.value, f.end.value);
  if (endISO <= startISO) return showError(errEl, "Конец должен быть позже начала");

  const conflict = await findConflict(startISO, endISO, people);
  if (conflict) {
    const slot = await suggestSlot(startISO, endISO, people);
    return showConflict(errEl, conflict, slot, f);
  }

  const { error } = await db.from("meetings").insert({
    title: f.title.value.trim(),
    starts_at: startISO,
    ends_at: endISO,
    participants: people,
  });
  if (error) return showError(errEl, error.message);

  closeModal();
  calendar.refetchEvents();
}

function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Показать конфликт + кнопку «подставить» ближайший свободный слот.
function showConflict(el, conflict, slot, form) {
  const m = conflict.meeting;
  el.classList.remove("hidden");
  el.innerHTML = `${conflict.people.map(escapeHtml).join(", ")} занят(ы): «${escapeHtml(m.title)}» ${fmtTime(m.starts_at)}–${fmtTime(m.ends_at)}.`;
  if (!slot) { el.innerHTML += "<br>Свободных слотов в этот день нет."; return; }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link";
  btn.textContent = `Ближайший свободный: ${timeVal(slot.start)}–${timeVal(slot.end)} → подставить`;
  btn.onclick = () => {
    form.start.value = timeVal(slot.start);
    form.end.value = timeVal(slot.end);
    el.classList.add("hidden");
  };
  el.appendChild(document.createElement("br"));
  el.appendChild(btn);
}

// Ближайший слот той же длительности в этот день, где никто из участников не занят.
async function suggestSlot(startISO, endISO, people) {
  const start = new Date(startISO);
  const durMs = new Date(endISO) - start;
  const dayStart = new Date(start); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(start); dayEnd.setUTCHours(22, 0, 0, 0); // = slotMaxTime календаря

  const { data } = await db.from("meetings").select("*")
    .gte("starts_at", dayStart.toISOString())
    .lt("starts_at", dayEnd.toISOString());

  const busy = (data || [])
    .filter(m => m.participants.some(p => people.includes(p)))
    .map(m => [new Date(m.starts_at).getTime(), new Date(m.ends_at).getTime()])
    .sort((a, b) => a[0] - b[0]);

  let c = start.getTime();
  const limit = dayEnd.getTime();
  while (c + durMs <= limit) {
    const clash = busy.find(([bs, be]) => bs < c + durMs && c < be);
    if (!clash) return { start: new Date(c), end: new Date(c + durMs) };
    c = clash[1]; // сдвигаемся к концу мешающей встречи
  }
  return null;
}

// ---------- модалка ----------
function openModal(start, end) {
  const box = document.getElementById("participants");
  box.innerHTML = window.EMPLOYEES
    .map(n => `<label class="chk"><input type="checkbox" name="p" value="${n}"> ${n}</label>`)
    .join("");

  const form = document.getElementById("meeting-form");
  form.reset();
  const s = start || nowMsk();
  const eTime = end || new Date(s.getTime() + 60 * 60 * 1000); // +1 час по умолчанию
  form.date.value = dateVal(s);
  form.start.value = timeVal(s);
  form.end.value = timeVal(eTime);

  document.getElementById("form-error").classList.add("hidden");
  document.getElementById("modal").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal").classList.add("hidden"); }

// ---------- события ----------
document.getElementById("add-btn").onclick = () => openModal();
document.getElementById("cancel").onclick = closeModal;
document.getElementById("meeting-form").onsubmit = submit;
document.getElementById("modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
