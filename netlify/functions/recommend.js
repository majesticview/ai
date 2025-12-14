// netlify/functions/recommend.js
export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

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

  const moodGenre = (body.moodGenre ?? "").trim();
  const theme = (body.theme ?? "").trim();
  const watched = (body.watched ?? "").trim();
  const creatorName = (body.creatorName ?? "").trim();
  const constraints = (body.constraints ?? "").trim();

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

  const watchedLabel = mode === "movie" ? "이전에 봤던 영화" : "이전에 읽었던 책";
  const creatorLabel = mode === "movie" ? "감독" : "저자";

  // 제목만 3줄로 받기(설명/번호/코드블록 금지)
  const prompt = `
너는 ${mode === "movie" ? "영화" : "도서"} 추천 큐레이터다.

[사용자 입력]
- 장르/분위기: ${moodGenre || "(미입력)"}
- 주제: ${theme || "(미입력)"}
- ${watchedLabel}(선택): ${watched || "(미입력)"}
- ${creatorLabel}(선택): ${creatorName || "(미입력)"}
- 자유 조건: ${constraints || "(미입력)"}

[중요 규칙]
- ${mode === "movie" ? "영화 제목만" : "도서 제목만"} 추천해라.
- 반드시 3개.
- 각 추천은 반드시 한 줄.
- 번호/불릿/따옴표/부가설명/코드블록 금지. 제목만 출력.
- ${watchedLabel}가 있으면 그 작품과 결이 비슷한 작품으로 추천해라(무관한 추천 금지).
- ${creatorLabel}가 있으면 가능하면 그 ${creatorLabel}의 작품(또는 유사한 결)을 우선해라.

이제 제목만 3줄로 출력해.
`.trim();

  const callGemini = async (temperature = 0.5) => {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: 250 },
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

  const parseTitles = (text) => {
    const cleaned = String(text || "")
      .replace(/^```[\s\S]*?\n/i, "")
      .replace(/```$/i, "")
      .trim();

    const lines = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim())
      .map((l) => l.replace(/^["“”']|["“”']$/g, "").trim()) // 혹시 따옴표가 붙으면 제거
      .filter(Boolean);

    // 너무 길게(설명 포함) 오면 제목만 대충 앞부분으로 자르기(최후의 안전장치)
    const normalized = lines.map((l) => {
      // "제목 - 설명..." 같은 경우 " - " 앞까지만
      if (l.includes(" - ")) return l.split(" - ")[0].trim();
      if (l.includes(" — ")) return l.split(" — ")[0].trim();
      return l;
    });

    // 중복 제거 + 3개로 제한
    const seen = new Set();
    const titles = [];
    for (const t of normalized) {
      const key = t.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      titles.push(t);
      if (titles.length >= 3) break;
    }
    return titles;
  };

  const fallbackItems = () => {
    const seed = [watched, creatorName, moodGenre, theme].filter(Boolean).join(" ").trim();
    const baseReason = seed
      ? `AI 응답이 불안정하여 입력("${seed}") 기반 검색용 대체 추천입니다.`
      : `입력 정보가 부족해 기본 추천입니다.`;

    const titles = seed
      ? [
          `${seed} 비슷한 ${mode === "movie" ? "영화" : "책"}`,
          `${seed} 추천 ${mode === "movie" ? "영화" : "도서"}`,
          `${seed} ${mode === "movie" ? "분위기" : "주제"} ${mode === "movie" ? "영화" : "책"}`,
        ]
      : mode === "movie"
      ? ["인셉션", "리틀 포레스트", "기생충"]
      : ["아몬드", "데미안", "미움받을 용기"];

    return titles.slice(0, 3).map((title) => {
      // 검색 정확도: 사용자가 입력한 감독/저자가 있으면 검색어에 섞음
      const q = [title, creatorName].filter(Boolean).join(" ").trim();
      return {
        title,
        creator: "",
        year: "",
        reason: baseReason,
        externalUrl: makeExternalUrl(q || title),
        detailUrl: makeDetailUrl(q || title),
      };
    });
  };

  try {
    // 1차 시도
    const text1 = await callGemini(0.6);
    let titles = parseTitles(text1);

    // 부족하면 2차(더 결정론)
    if (titles.length < 3) {
      const text2 = await callGemini(0.1);
      const t2 = parseTitles(text2);
      titles = [...titles, ...t2];
      titles = [...new Set(titles.map((x) => x.trim()))].filter(Boolean).slice(0, 3);
    }

    if (titles.length === 0) {
      return new Response(JSON.stringify({ mode, items: fallbackItems(), note: "fallback" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // items 구성(creator/year/reason은 비워도 프론트 렌더링은 됨)
    const items = titles.slice(0, 3).map((title) => {
      const q = [title, creatorName].filter(Boolean).join(" ").trim();
      return {
        title,
        creator: "",
        year: "",
        reason: "입력하신 조건과 취향을 반영한 추천입니다.",
        externalUrl: makeExternalUrl(q || title),
        detailUrl: makeDetailUrl(q || title),
      };
    });

    // 3개 미만이면 fallback으로 채움
    if (items.length < 3) {
      const fb = fallbackItems();
      const seen = new Set(items.map((x) => x.title.toLowerCase()));
      for (const f of fb) {
        if (items.length >= 3) break;
        if (seen.has(f.title.toLowerCase())) continue;
        items.push(f);
      }
    }

    return new Response(JSON.stringify({ mode, items }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch {
    return new Response(JSON.stringify({ mode, items: fallbackItems(), note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
