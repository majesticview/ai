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

  const creatorLabel = mode === "movie" ? "감독" : "저자";
  const watchedLabel = mode === "movie" ? "이전에 봤던 영화" : "이전에 읽었던 책";

  // ===== 1) Gemini 호출 유틸 (프롬프트를 인자로 받게) =====
  const callGemini = async (prompt, temperature = 0.4, maxOutputTokens = 700) => {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens },
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

  // ===== 2) 입력 기반 fallback (연관성 유지) =====
  const fallbackItems = () => {
    const seed = [watched, creatorName, moodGenre, theme, constraints].filter(Boolean).join(" ").trim();
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

    return titles.slice(0, 3).map((t) => ({
      title: t,
      creator: "",
      year: "",
      reason: baseReason,
      externalUrl: makeExternalUrl(t),
      detailUrl: makeDetailUrl(t),
    }));
  };

  // ===== 3) 관대한 파서: 탭 우선, 그 외 형식도 최대한 흡수 =====
  const parseList = (text) => {
    const cleaned = String(text || "")
      .replace(/^```[\s\S]*?\n/i, "")
      .replace(/```$/i, "")
      .trim();

    const lines = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20);

    const items = [];

    for (const raw0 of lines) {
      if (items.length >= 3) break;

      // 번호/불릿 제거
      const raw = raw0.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim();
      if (!raw) continue;

      let title = "";
      let creator = "";
      let year = "";
      let reason = "";

      // (1) 탭 포맷: 제목\t창작자\t연도\t이유
      if (raw.includes("\t")) {
        const cols = raw.split("\t").map((x) => x.trim());
        title = (cols[0] ?? "").trim();
        creator = (cols[1] ?? "").trim();
        year = (cols[2] ?? "").trim();
        reason = (cols[3] ?? "").trim();
      } else {
        // (2) 파이프 포맷: 제목 | creator= | year= | reason=
        if (raw.includes("|")) {
          const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
          title = (parts[0] ?? "").trim();
          for (let i = 1; i < parts.length; i++) {
            const p = parts[i];
            const lower = p.toLowerCase();
            if (lower.startsWith("creator=")) creator = p.slice("creator=".length).trim();
            else if (lower.startsWith("director=")) creator = p.slice("director=".length).trim();
            else if (lower.startsWith("author=")) creator = p.slice("author=".length).trim();
            else if (lower.startsWith("year=")) year = p.slice("year=".length).trim();
            else if (lower.startsWith("reason=")) reason = p.slice("reason=".length).trim();
          }
        } else {
          // (3) "제목 — 창작자" / "제목 - 창작자" / "제목: 창작자"
          const sep =
            raw.includes("—") ? "—" :
            raw.includes(" - ") ? " - " :
            raw.includes(":") ? ":" :
            null;

          if (sep) {
            const p = raw.split(sep);
            title = (p[0] ?? "").trim();
            creator = p.slice(1).join(sep).trim();
          } else {
            title = raw.trim();
          }

          // (4) "제목 (감독: XXX)" / "제목 (저자: XXX)" 보정
          const m = raw.match(/^(.*?)\s*\((?:감독|저자|작가|author|director)\s*:\s*(.*?)\)\s*$/i);
          if (m) {
            title = (m[1] ?? "").trim();
            creator = (m[2] ?? "").trim();
          }
        }
      }

      // year 정규화 (있으면 4자리만 인정)
      if (year && !/^\d{4}$/.test(year)) year = "";

      if (!title) continue;
      if (!reason) reason = "입력하신 조건과 취향을 반영한 추천입니다.";

      const q = [title, creator].filter(Boolean).join(" ").trim();

      items.push({
        title,
        creator,
        year,
        reason,
        externalUrl: makeExternalUrl(q || title),
        detailUrl: makeDetailUrl([title, creator, year].filter(Boolean).join(" ")),
      });
    }

    // 중복 제거
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

  // ===== 4) 메인 프롬프트: 탭( \t ) 포맷을 강제 + 연관성 규칙 강화 =====
  const mainPrompt = `
너는 ${mode === "movie" ? "영화" : "도서"} 추천 큐레이터다.

[사용자 입력]
- 장르/분위기: ${moodGenre || "(미입력)"}
- 주제: ${theme || "(미입력)"}
- ${watchedLabel}(선택): ${watched || "(미입력)"}
- ${creatorLabel}(선택): ${creatorName || "(미입력)"}
- 자유 조건: ${constraints || "(미입력)"}

[연관성 규칙(중요)]
- ${watchedLabel}가 입력되면, 추천은 반드시 그 작품과 "장르/분위기/정서/전개 템포"가 유사해야 한다. 무관한 추천 금지.
- ${creatorLabel}가 입력되면, 가능하면 해당 ${creatorLabel}의 작품을 1개 이상 포함하거나 매우 유사한 결의 작품을 추천하라.
- 자유 조건을 우선 반영하라(예: "잔인한 장면 X"면 폭력적 작품 추천 금지).

[출력 규칙(엄격)]
- 반드시 3줄만 출력
- 다른 문장/설명/번호/기호/코드블록 금지
- 각 줄은 아래 4개 컬럼을 "탭(\\t)"으로 구분해서 출력:
제목<TAB>${creatorLabel}<TAB>연도(4자리 또는 빈칸)<TAB>추천이유(1문장)

예시(탭 구분):
기생충\t봉준호\t2019\t사회 풍자와 긴장감 있는 전개가 주제/분위기와 잘 맞습니다.
`.trim();

  // ===== 5) Self-repair 프롬프트 =====
  const repairPrompt = (badText) => `
아래 텍스트를 규칙에 맞게 다시 정리해라.

[규칙(엄격)]
- 반드시 3줄만 출력
- 각 줄: 제목<TAB>${creatorLabel}<TAB>연도(4자리 또는 빈칸)<TAB>추천이유(1문장)
- 다른 설명/번호/코드블록 금지

[원문]
${badText}
`.trim();

  try {
    // 1차 시도
    const text1 = await callGemini(mainPrompt, 0.5, 650);
    let items = parseList(text1);

    // 파싱이 약하면 “재포맷” 1회
    if (items.length < 2) {
      const text2 = await callGemini(repairPrompt(text1), 0.0, 450);
      items = parseList(text2);
    }

    // 그래도 부족하면 fallback으로 채움
    if (items.length < 3) {
      const fb = fallbackItems();
      const seen = new Set(items.map((x) => x.title.toLowerCase()));
      for (const f of fb) {
        if (items.length >= 3) break;
        if (seen.has(f.title.toLowerCase())) continue;
        items.push(f);
      }
    }

    // 최종 보정: 0이면 fallback
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
  } catch {
    return new Response(JSON.stringify({ mode, items: fallbackItems(), note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
