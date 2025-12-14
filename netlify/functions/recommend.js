// netlify/functions/recommend.js
export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return new Response("Missing GEMINI_API_KEY", { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const mode = body.mode === "movie" ? "movie" : body.mode === "book" ? "book" : null;
  if (!mode) return new Response("mode must be 'movie' or 'book'", { status: 400 });

  // NEW inputs
  const moodGenre = (body.moodGenre ?? "").trim();       // 1) 장르/분위기
  const theme = (body.theme ?? "").trim();               // 2) 주제
  const watched = (body.watched ?? "").trim();           // 3) 이전에 봤던 작품(선택)
  const creatorName = (body.creatorName ?? "").trim();   // 4) 감독/저자(선택)
  const constraints = (body.constraints ?? "").trim();   // 5) 자유 조건

  // --- 링크 생성 ---
  const makeExternalUrl = (query) => {
    if (!query) return "";
    if (mode === "movie") {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(query + " 예고편")}`;
    }
    return `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(query)}`;
  };

  const makeDetailUrl = (query) => {
    if (!query) return "";
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  };

  // --- 입력 기반 fallback: "연관 없는 고정 추천" 방지 ---
  const fallbackItems = () => {
    const seed = [watched, creatorName, moodGenre, theme, constraints]
      .filter(Boolean)
      .join(" ")
      .trim();

    // 입력이 정말 아무것도 없을 때만 최소 기본값
    if (!seed) {
      return mode === "movie"
        ? [
            { title: "인셉션", creator: "크리스토퍼 놀란", year: "2010", reason: "입력 정보가 부족해 대표작을 추천합니다." },
            { title: "리틀 포레스트", creator: "", year: "", reason: "입력 정보가 부족해 편하게 보기 좋은 작품을 추천합니다." },
            { title: "기생충", creator: "봉준호", year: "2019", reason: "입력 정보가 부족해 대중적 평가가 높은 작품을 추천합니다." },
          ]
        : [
            { title: "아몬드", creator: "손원평", year: "", reason: "입력 정보가 부족해 가독성 좋은 소설을 추천합니다." },
            { title: "데미안", creator: "헤르만 헤세", year: "", reason: "입력 정보가 부족해 대표 고전을 추천합니다." },
            { title: "미움받을 용기", creator: "", year: "", reason: "입력 정보가 부족해 대중적인 자기계발서를 추천합니다." },
          ];
    }

    const baseReason = `AI 응답이 불안정하여 입력("${seed}") 기반으로 연관 검색이 가능한 형태로 안내합니다.`;

    // 실제 작품명을 확정 못 해도 검색 연관성은 확보
    return [
      { title: `${seed} 비슷한 ${mode === "movie" ? "영화" : "책"}`, creator: "", year: "", reason: baseReason },
      { title: `${seed} 추천 ${mode === "movie" ? "영화" : "도서"}`, creator: "", year: "", reason: baseReason },
      { title: `${seed} ${mode === "movie" ? "분위기" : "주제"} ${mode === "movie" ? "영화" : "책"}`, creator: "", year: "", reason: baseReason },
    ];
  };

  // --- 텍스트 파서(관대하게) ---
  const parseTextToItems = (rawText) => {
    if (!rawText) return [];
    let text = String(rawText).trim();

    // 코드블록 제거
    text = text.replace(/^```[\s\S]*?\n/i, (m) => m.replace(/```(?:json|text)?/i, "")).trim();
    text = text.replace(/```$/i, "").trim();

    const chunks = text
      .split(/\n|;\s*/g)
      .map((s) => s.trim())
      .filter(Boolean);

    const items = [];
    for (const chunk0 of chunks) {
      if (items.length >= 3) break;

      const chunk = chunk0.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim();
      if (!chunk) continue;

      const parts = chunk.includes("|")
        ? chunk.split("|").map((p) => p.trim()).filter(Boolean)
        : chunk.split(" / ").map((p) => p.trim()).filter(Boolean);

      if (parts.length === 0) continue;

      const title = (parts[0] ?? "").trim();
      let creator = "";
      let year = "";
      let reason = "";

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const lower = p.toLowerCase();

        if (lower.startsWith("creator=")) creator = p.slice("creator=".length).trim();
        else if (lower.startsWith("author=")) creator = p.slice("author=".length).trim();
        else if (lower.startsWith("director=")) creator = p.slice("director=".length).trim();
        else if (lower.startsWith("year=")) year = p.slice("year=".length).trim();
        else if (lower.startsWith("reason=")) reason = p.slice("reason=".length).trim();
        else reason = reason ? `${reason} ${p}` : p;
      }

      if (!title) continue;

      if (year && !/^\d{4}$/.test(year)) year = "";

      if (!reason) {
        reason =
          mode === "movie"
            ? "입력하신 조건에 맞춘 추천입니다."
            : "입력하신 조건에 맞춘 추천입니다.";
      }

      const q = [title, creator].filter(Boolean).join(" ").trim();

      items.push({
        title,
        creator,
        year,
        reason,
        // 감독/저자까지 포함해서 검색 정확도 올림
        externalUrl: makeExternalUrl(q || title),
        detailUrl: makeDetailUrl([title, creator, year].filter(Boolean).join(" ")),
      });
    }

    return items;
  };

  // --- 프롬프트: 연관성 강제(중요) ---
  const creatorLabel = mode === "movie" ? "감독" : "저자";
  const watchedLabel = mode === "movie" ? "이전에 봤던 영화" : "이전에 읽었던 책";

  const instruction = `
너는 ${mode === "movie" ? "영화" : "도서"} 추천 엔진이다.

[최우선 목표]
사용자 입력과의 연관성이 낮은 추천은 금지한다.

[반영 규칙(엄격)]
- "${watchedLabel}"가 입력된 경우:
  - 추천작은 그 작품과 장르/분위기/정서/전개 템포가 유사해야 한다.
  - 너무 동떨어진 작품은 절대 추천하지 마라.
- "${creatorLabel}"가 입력된 경우:
  - 가능하면 해당 ${creatorLabel}의 작품을 1개 이상 포함하라.
  - 불가능하면, 그 ${creatorLabel}과 결이 유사한 작품을 제시하라(이유에 명시).
- 장르/분위기, 주제, 자유 조건을 모두 고려하라(충돌 시 사용자 조건 우선).

[출력 규칙]
- 3개 출력(최소 2개)
- 각 추천은 한 줄씩 줄바꿈으로 구분
- 머리말/꼬리말/설명/코드블록 금지

[형식]
제목 | creator=${creatorLabel}(모르면비움) | year=YYYY(모르면비움) | reason=1~2문장(반드시 '어떤 입력을 어떻게 반영했는지' 포함)
`.trim();

  const userPrompt = `
[사용자 입력]
- 장르/분위기: ${moodGenre || "(미입력)"}
- 주제: ${theme || "(미입력)"}
- ${watchedLabel}(선택): ${watched || "(미입력)"}
- ${creatorLabel}(선택): ${creatorName || "(미입력)"}
- 자유 조건: ${constraints || "(미입력)"}

위 입력을 강하게 반영해서 추천해줘.
`.trim();

  // --- Gemini 호출(재시도) ---
  const callGemini = async (temperature) => {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: instruction + "\n\n" + userPrompt }] }],
        generationConfig: { temperature, maxOutputTokens: 800 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error: ${errText}`);
    }

    const json = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts
        ?.map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim() ?? "";

    return text;
  };

  const ensure2to3Items = (items) => {
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      const key = (it.title || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
      if (uniq.length >= 3) break;
    }
    return uniq;
  };

  try {
    let items = [];

    // 1차: 약간 창의
    try {
      const text = await callGemini(0.7);
      items = ensure2to3Items(parseTextToItems(text));
    } catch {
      items = [];
    }

    // 2차: 더 엄격하게(포맷/조건 준수 유도)
    if (items.length < 2) {
      try {
        const text = await callGemini(0.2);
        items = ensure2to3Items(parseTextToItems(text));
      } catch {
        items = [];
      }
    }

    // 3차: 거의 결정론
    if (items.length < 2) {
      try {
        const text = await callGemini(0.0);
        items = ensure2to3Items(parseTextToItems(text));
      } catch {
        items = [];
      }
    }

    // 그래도 실패하면 fallback(입력 기반)
    if (items.length < 2) {
      const base = fallbackItems().map((x) => {
        const q = [x.title, x.creator].filter(Boolean).join(" ").trim();
        return {
          ...x,
          externalUrl: makeExternalUrl(q || x.title),
          detailUrl: makeDetailUrl([x.title, x.creator, x.year].filter(Boolean).join(" ")),
        };
      });

      return new Response(JSON.stringify({ mode, items: base.slice(0, 3), note: "fallback" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 3개 미만이면 fallback에서 채워 넣기(중복 제외)
    if (items.length < 3) {
      const base = fallbackItems();
      for (const f of base) {
        if (items.length >= 3) break;
        if (items.some((it) => it.title.toLowerCase() === f.title.toLowerCase())) continue;

        const q = [f.title, f.creator].filter(Boolean).join(" ").trim();
        items.push({
          ...f,
          externalUrl: makeExternalUrl(q || f.title),
          detailUrl: makeDetailUrl([f.title, f.creator, f.year].filter(Boolean).join(" ")),
        });
      }
    }

    return new Response(JSON.stringify({ mode, items: items.slice(0, 3) }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch {
    // 어떤 경우에도 200 + fallback
    const base = fallbackItems().map((x) => {
      const q = [x.title, x.creator].filter(Boolean).join(" ").trim();
      return {
        ...x,
        externalUrl: makeExternalUrl(q || x.title),
        detailUrl: makeDetailUrl([x.title, x.creator, x.year].filter(Boolean).join(" ")),
      };
    });

    return new Response(JSON.stringify({ mode, items: base.slice(0, 3), note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
