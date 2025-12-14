// netlify/functions/recommend.js
export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response("Missing GEMINI_API_KEY", { status: 500 });
  }

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

  // YouTube/서점 검색 링크 생성 유틸
  const makeExternalUrl = (query) => {
    if (!query) return "";
    if (mode === "movie") {
      // 유튜브 검색(예고편 키워드 포함)
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(query + " 예고편")}`;
    }
    // 온라인 서점 검색(예: 교보문고 검색 URL)
    return `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(query)}`;
  };

  const makeDetailUrl = (query) => {
    // “상세 정보”는 보통 위 검색 링크로도 충분하지만,
    // 영화는 구글/위키/IMDb 등, 도서는 교보/알라딘 등으로 추가 링크를 줄 수 있음.
    // 여기서는 간단히 구글 검색 링크를 하나 더 제공합니다.
    if (!query) return "";
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  };

  // Gemini에 JSON 형식을 강제하기 위한 프롬프트
  const systemHint = `
너는 콘텐츠 추천 엔진이다.
반드시 아래 JSON 스키마만 출력한다. 다른 텍스트를 섞지 않는다.

{
  "mode": "movie" | "book",
  "items": [
    {
      "title": string,
      "creator": string,   // 영화면 감독 또는 주요 제작자, 도서면 저자
      "year": string,      // 모르면 빈 문자열
      "reason": string     // 2~4문장으로 추천 이유
    }
  ]
}

규칙:
- items는 2~3개
- 최신/고전 적절히 섞기(가능하면)
- 사용자가 언급한 취향/상황을 반영
- 잘 모르는 정보는 추측하지 말고 빈 문자열로 둔다
`.trim();

  const userPrompt = `
추천 종류: ${mode === "movie" ? "영화" : "도서"}
주제/분위기: ${topic || "(미입력)"}
이전에 좋아한 작품: ${history || "(미입력)"}
상황/조건: ${situation || "(미입력)"}

위 정보를 반영해 2~3개 추천해줘.
`.trim();

  try {
    // Gemini REST 호출 (Generative Language API)
    // 모델명은 필요에 따라 변경 가능: gemini-1.5-flash, gemini-1.5-pro 등
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: systemHint + "\n\n" + userPrompt }] }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 700
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(`Gemini API error: ${errText}`, { status: 502 });
    }

    const geminiJson = await geminiRes.json();

    // Gemini 응답 텍스트 추출
    const text =
      geminiJson?.candidates?.[0]?.content?.parts?.map(p => p.text).join("")?.trim() ?? "";

    // JSON만 나온다는 가정이지만, 안전하게 앞뒤 잡텍스트 제거 시도
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
      return new Response("Model did not return JSON", { status: 502 });
    }

    const jsonText = text.slice(firstBrace, lastBrace + 1);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return new Response("Failed to parse model JSON", { status: 502 });
    }

    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 3) : [];

    // 링크 붙이기(백엔드에서 파싱 후 확보)
    const enriched = items.map((it) => {
      const title = (it?.title ?? "").toString().trim();
      const creator = (it?.creator ?? "").toString().trim();
      const year = (it?.year ?? "").toString().trim();
      const reason = (it?.reason ?? "").toString().trim();

      const q = [title, creator, year].filter(Boolean).join(" ");
      return {
        title,
        creator,
        year,
        reason,
        externalUrl: makeExternalUrl(title || q),
        detailUrl: makeDetailUrl(q || title),
      };
    }).filter(x => x.title);

    const responsePayload = {
      mode,
      items: enriched
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    return new Response(`Server exception: ${e.message}`, { status: 500 });
  }
};
