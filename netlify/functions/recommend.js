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

  const topic = (body.topic ?? "").trim();
  const history = (body.history ?? "").trim();
  const situation = (body.situation ?? "").trim();

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

  // --- 서버 fallback (무조건 2~3개 반환용) ---
  const fallbackItems = () => {
    if (mode === "movie") {
      return [
        {
          title: "인셉션",
          creator: "크리스토퍼 놀란",
          year: "2010",
          reason: "몰입감 있는 전개와 반전, 강한 서스펜스가 있는 작품입니다.",
        },
        {
          title: "리틀 포레스트",
          creator: "",
          year: "",
          reason: "잔잔하고 힐링되는 분위기, 편안한 감정선이 필요할 때 잘 맞습니다.",
        },
        {
          title: "매드 맥스: 분노의 도로",
          creator: "",
          year: "",
          reason: "강렬한 액션과 속도감으로 스트레스 해소용으로 좋습니다.",
        },
      ];
    }

    return [
      {
        title: "데미안",
        creator: "헤르만 헤세",
        year: "",
        reason: "자기 탐색과 성장 서사를 좋아한다면 만족도가 높은 고전입니다.",
      },
      {
        title: "아몬드",
        creator: "손원평",
        year: "",
        reason: "감정과 관계를 섬세하게 다루며, 가독성이 좋아 부담 없이 읽기 좋습니다.",
      },
      {
        title: "미움받을 용기",
        creator: "",
        year: "",
        reason: "관계/자존감/삶의 태도에 대한 관점을 정리하고 싶을 때 도움이 됩니다.",
      },
    ];
  };

  // --- 텍스트 파서: 포맷이 깨져도 최대한 복구 ---
  const parseTextToItems = (rawText) => {
    if (!rawText) return [];
    let text = String(rawText).trim();

    // 코드블록 제거
    text = text.replace(/^```[\s\S]*?\n/i, (m) => m.replace(/```(?:json|text)?/i, "")).trim();
    text = text.replace(/```$/i, "").trim();

    // 여러 추천을 한 줄에 쓰는 경우 대비: 줄바꿈/세미콜론으로 먼저 분리
    const chunks = text
      .split(/\n|;\s*/g)
      .map((s) => s.trim())
      .filter(Boolean);

    const items = [];
    for (const chunk0 of chunks) {
      if (items.length >= 3) break;

      // 번호/불릿 제거
      const chunk = chunk0.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim();
      if (!chunk) continue;

      // 우리가 의도한 포맷: 제목 | creator= | year= | reason=
      // 근데 모델이 "|"를 빼고 콤마로 쓰는 경우도 있어서 약하게 허용
      const parts = chunk.includes("|")
        ? chunk.split("|").map((p) => p.trim()).filter(Boolean)
        : chunk.split(" / ").map((p) => p.trim()).filter(Boolean);

      if (parts.length === 0) continue;

      let title = (parts[0] ?? "").trim();
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
        else {
          // reason 키가 없어도 나머지는 reason으로 흡수
          reason = reason ? `${reason} ${p}` : p;
        }
      }

      // 제목이 비었으면 스킵
      if (!title) continue;

      // reason이 비면 기본 문구 채움(무조건 통과)
      if (!reason) {
        reason =
          mode === "movie"
            ? "요청하신 취향/상황에 맞춰 부담 없이 즐길 수 있는 작품으로 추천합니다."
            : "요청하신 취향/상황에 맞춰 읽기 좋은 책으로 추천합니다.";
      }

      // year가 숫자가 아닌 이상한 값이면 비우기(추측 방지)
      if (year && !/^\d{4}$/.test(year)) year = "";

      // 링크용 쿼리
      const q = [title, creator, year].filter(Boolean).join(" ").trim();

      items.push({
        title,
        creator,
        year,
        reason,
        externalUrl: makeExternalUrl(title || q),
        detailUrl: makeDetailUrl(q || title),
      });
    }

    return items;
  };

  // --- 프롬프트: “2~3개 반드시” + “줄바꿈으로 분리”만 강제 (너무 빡세게 안 함) ---
  const instruction = `
너는 콘텐츠 추천 엔진이다.
반드시 추천 3개를 출력하라(최소 2개).
각 추천은 반드시 한 줄씩 줄바꿈으로 구분한다.
추가 설명/머리말/꼬리말/코드블록 금지.

각 줄 형식(가능한 한 지켜라):
제목 | creator=... | year=.... | reason=...

creator/year/reason을 모르면 빈 값으로 둔다(예: year=).
`.trim();

  const userPrompt = `
추천 종류: ${mode === "movie" ? "영화" : "도서"}
주제/분위기: ${topic || "(미입력)"}
이전에 좋아한 작품: ${history || "(미입력)"}
상황/조건: ${situation || "(미입력)"}

위 정보를 반영해 추천해줘.
`.trim();

  // --- Gemini 호출 (재시도 포함) ---
  const callGemini = async (temperature) => {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: instruction + "\n\n" + userPrompt }] }
        ],
        generationConfig: {
          temperature,
          maxOutputTokens: 700,
        },
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
    // 중복 제목 제거 + 3개로 맞추기
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
    let text = "";
    let items = [];

    // 1차: 기본 온도
    try {
      text = await callGemini(0.8);
      items = parseTextToItems(text);
      items = ensure2to3Items(items);
    } catch {
      items = [];
    }

    // 2차: 포맷 준수 유도(온도 낮춤)
    if (items.length < 2) {
      try {
        text = await callGemini(0.2);
        items = parseTextToItems(text);
        items = ensure2to3Items(items);
      } catch {
        items = [];
      }
    }

    // 3차: 더 낮춤 (마지막 시도)
    if (items.length < 2) {
      try {
        text = await callGemini(0.0);
        items = parseTextToItems(text);
        items = ensure2to3Items(items);
      } catch {
        items = [];
      }
    }

    // 그래도 부족하면 fallback 채워서 "무조건" 반환
    if (items.length < 2) {
      const base = fallbackItems().map((x) => {
        const q = [x.title, x.creator, x.year].filter(Boolean).join(" ").trim();
        return {
          ...x,
          externalUrl: makeExternalUrl(x.title || q),
          detailUrl: makeDetailUrl(q || x.title),
        };
      });

      return new Response(JSON.stringify({ mode, items: base.slice(0, 3) }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 부족하면 fallback에서 남은 개수만큼 채움
    if (items.length < 3) {
      const base = fallbackItems();
      for (const f of base) {
        if (items.length >= 3) break;
        if (items.some((it) => it.title.toLowerCase() === f.title.toLowerCase())) continue;

        const q = [f.title, f.creator, f.year].filter(Boolean).join(" ").trim();
        items.push({
          ...f,
          externalUrl: makeExternalUrl(f.title || q),
          detailUrl: makeDetailUrl(q || f.title),
        });
      }
    }

    return new Response(JSON.stringify({ mode, items: items.slice(0, 3) }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    // 최악의 경우에도 200 + fallback으로 반환(“무조건 추천” 요구사항)
    const base = fallbackItems().map((x) => {
      const q = [x.title, x.creator, x.year].filter(Boolean).join(" ").trim();
      return {
        ...x,
        externalUrl: makeExternalUrl(x.title || q),
        detailUrl: makeDetailUrl(q || x.title),
      };
    });

    return new Response(JSON.stringify({ mode, items: base.slice(0, 3), note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
