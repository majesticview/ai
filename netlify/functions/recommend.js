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

  // 다른 팀처럼 "줄바꿈 리스트"만 받기 위한 프롬프트
  const creatorLabel = mode === "movie" ? "감독" : "저자";
  const watchedLabel = mode === "movie" ? "이전에 봤던 영화" : "이전에 읽었던 책";

  const prompt = `
너는 ${mode === "movie" ? "영화" : "도서"} 추천 큐레이터야.

[사용자 입력]
- 장르/분위기: ${moodGenre || "(미입력)"}
- 주제: ${theme || "(미입력)"}
- ${watchedLabel}(선택): ${watched || "(미입력)"}
- ${creatorLabel}(선택): ${creatorName || "(미입력)"}
- 자유 조건: ${constraints || "(미입력)"}

규칙:
- ${mode === "movie" ? "영화만" : "도서만"} 추천해.
- 총 3개 추천해.
- 출력 형식은 오직 아래 한 줄 형식만 사용해(설명/번호/머리말/코드블록 금지):
제목 — ${creatorLabel}
- ${creatorLabel}를 모르면 "제목 — " 처럼 비워도 됨.
- 추천이 사용자의 입력과 연관되도록(특히 ${watchedLabel}, ${creatorLabel}) 최대한 반영해.

이제 3줄로만 출력해.
`.trim();

  const callGemini = async () => {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 500 },
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

  const fallbackItems = () => {
    const seed = [watched, creatorName, moodGenre, theme].filter(Boolean).join(" ").trim();
    const baseReason = seed
      ? `입력("${seed}") 기반으로 연관 검색이 가능한 대체 추천입니다.`
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

    return titles.slice(0, 3).map((t) => ({
      title: t,
      creator: "",
      year: "",
      reason: baseReason,
      externalUrl: makeExternalUrl(t),
      detailUrl: makeDetailUrl(t),
    }));
  };

  // 텍스트 파서(줄바꿈 3줄을 제목/creator로 분리)
  const parseList = (text) => {
    const cleaned = String(text || "")
      .replace(/^```[\s\S]*?\n/i, "")
      .replace(/```$/i, "")
      .trim();

    const lines = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 10);

    const items = [];
    for (const line0 of lines) {
      if (items.length >= 3) break;

      // 번호/불릿 제거
      const line = line0.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim();
      if (!line) continue;

      // "제목 — 감독" 형태 파싱(—, -, | 허용)
      let title = line;
      let creator = "";

      const sepMatch = line.split("—");
      if (sepMatch.length >= 2) {
        title = sepMatch[0].trim();
        creator = sepMatch.slice(1).join("—").trim();
      } else if (line.includes(" - ")) {
        const p = line.split(" - ");
        title = p[0].trim();
        creator = p.slice(1).join(" - ").trim();
      } else if (line.includes("|")) {
        const p = line.split("|");
        title = p[0].trim();
        creator = p.slice(1).join("|").trim();
      }

      if (!title) continue;

      const q = [title, creator].filter(Boolean).join(" ").trim();
      items.push({
        title,
        creator,
        year: "",
        reason: "입력하신 조건과 취향을 반영한 추천입니다.",
        externalUrl: makeExternalUrl(q || title),
        detailUrl: makeDetailUrl(q || title),
      });
    }

    return items;
  };

  try {
    const text = await callGemini();
    let items = parseList(text);

    // 3개가 안 나오면 fallback으로 채움
    if (items.length < 3) {
      const fb = fallbackItems();
      const seen = new Set(items.map((x) => x.title.toLowerCase()));
      for (const f of fb) {
        if (items.length >= 3) break;
        if (seen.has(f.title.toLowerCase())) continue;
        items.push(f);
      }
    }

    // 그래도 0이면 그냥 fallback
    if (items.length === 0) {
      return new Response(JSON.stringify({ mode, items: fallbackItems(), note: "fallback" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response(JSON.stringify({ mode, items: items.slice(0, 3) }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    // 에러여도 무조건 반환
    return new Response(JSON.stringify({ mode, items: fallbackItems(), note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
