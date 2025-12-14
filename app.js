const el = (id) => document.getElementById(id);

const btnMovie = el("btnMovie");
const btnBook = el("btnBook");
const form = el("form");
const modePill = el("modePill");
const statusEl = el("status");

// NEW inputs (HTML id도 이대로 맞춰야 함)
const moodGenreEl = el("moodGenre");     // 1) 장르/분위기
const themeEl = el("theme");             // 2) 주제
const watchedEl = el("watched");         // 3) 이전에 봤던 영화/도서(선택)
const creatorNameEl = el("creatorName"); // 4) 감독/저자(선택)
const constraintsEl = el("constraints"); // 5) 자유 조건

const btnReset = el("btnReset");
const btnRetry = el("btnRetry");

const resultCard = el("resultCard");
const resultsEl = el("results");

let mode = null; // "movie" | "book"

function setMode(next) {
  mode = next;
  document.body.classList.add("is-active");

  form.classList.remove("hidden");
  resultCard.classList.add("hidden");
  resultsEl.innerHTML = "";

  modePill.textContent = `선택됨: ${mode === "movie" ? "영화" : "도서"}`;
  statusEl.textContent = "";

  // 라벨/placeholder를 모드에 맞게(선택)
  const creatorLabel = form.querySelector('label[for="creatorName"] .label');
  if (creatorLabel) creatorLabel.textContent = mode === "movie" ? "4) (선택) 감독" : "4) (선택) 저자";
  if (creatorNameEl) creatorNameEl.placeholder = mode === "movie"
    ? "예: 크리스토퍼 놀란, 봉준호, 고레에다 히로카즈"
    : "예: 무라카미 하루키, 한강, 유발 하라리";
}

btnMovie.addEventListener("click", () => setMode("movie"));
btnBook.addEventListener("click", () => setMode("book"));

btnReset.addEventListener("click", () => {
  mode = null;
  document.body.classList.remove("is-active");

  form.classList.add("hidden");
  resultCard.classList.add("hidden");
  resultsEl.innerHTML = "";
  statusEl.textContent = "";

  moodGenreEl.value = "";
  themeEl.value = "";
  watchedEl.value = "";
  creatorNameEl.value = "";
  constraintsEl.value = "";
});

btnRetry.addEventListener("click", async () => {
  if (!mode) return;
  await requestRecommendations();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await requestRecommendations();
});

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderResults(payload) {
  const items = payload?.items ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    resultsEl.innerHTML = `<div class="item">추천 결과가 비어 있습니다. 다른 키워드로 다시 시도해보세요.</div>`;
    return;
  }

  resultsEl.innerHTML = items.map((it, idx) => {
    const title = escapeHtml(it.title ?? `추천 ${idx + 1}`);
    const creator = escapeHtml(it.creator ?? "");
    const year = escapeHtml(it.year ?? "");
    const reason = escapeHtml(it.reason ?? "");

    const linkLabel = mode === "movie" ? "유튜브에서 예고편 검색" : "온라인 서점에서 검색";
    const externalUrl = it.externalUrl ? escapeHtml(it.externalUrl) : "";
    const detailUrl = it.detailUrl ? escapeHtml(it.detailUrl) : "";

    return `
      <article class="item">
        <div class="itemTop">
          <h3 class="title">${title}</h3>
          <div class="meta">${creator}${creator && year ? " · " : ""}${year}</div>
        </div>
        <p class="desc">${reason}</p>
        <div class="links">
          ${externalUrl ? `<a class="link" href="${externalUrl}" target="_blank" rel="noopener noreferrer">${linkLabel}</a>` : ""}
          ${detailUrl ? `<a class="link" href="${detailUrl}" target="_blank" rel="noopener noreferrer">상세 정보</a>` : ""}
        </div>
      </article>
    `;
  }).join("");

  resultCard.classList.remove("hidden");
}

async function requestRecommendations() {
  if (!mode) {
    statusEl.textContent = "먼저 영화/도서 중 하나를 선택해주세요.";
    return;
  }

  const moodGenre = moodGenreEl.value.trim();
  const theme = themeEl.value.trim();
  const watched = watchedEl.value.trim();
  const creatorName = creatorNameEl.value.trim();
  const constraints = constraintsEl.value.trim();

  // 최소 입력: 1) or 2) 중 하나는 받자
  if (!moodGenre && !theme) {
    statusEl.textContent = "최소한 '장르/분위기' 또는 '주제' 중 하나는 입력해주세요.";
    return;
  }

  statusEl.textContent = "추천 생성 중...";
  resultsEl.innerHTML = "";
  resultCard.classList.add("hidden");

  try {
    const res = await fetch("/.netlify/functions/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        moodGenre,
        theme,
        watched,
        creatorName,
        constraints
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`서버 오류(${res.status}): ${text}`);
    }

    const data = await res.json();
    renderResults(data);

    if (data?.note === "fallback") {
      statusEl.textContent = "완료! (일부는 기본/대체 추천일 수 있어요)";
    } else {
      statusEl.textContent = "완료!";
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = `오류: ${err.message}`;
  }
}
