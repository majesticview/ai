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
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(query + " 예고편")}`;
    }
    return `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(query)}`;
  };

  const makeDetailUrl = (query) => {
    if (!query) return "";
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  };

  // JSON만 출력 강제 프롬프트
  const systemHint = `
너는 콘텐츠 추천 엔진이다.
출력은 반드시 JSON 객체 1개만 한다.
코드블록(\`\`\`) 사용 금지.
설명/머리말/꼬리말 등 JSON 이외 텍스트 절대 금지.
스키마를 반드시 지켜라.

스키마:
{
  "mode": "movie" | "book",
  "items": [
    {
      "title": string,
      "creator": string,
      "year": string,
      "reason": string
    }
  ]
}

규칙:
- items는 2~3개
- 사용자의 취향/상황을 반영
- 모르는 정보는 추측하지 말고 빈 문자열로 둔다
`.trim();

  const userPrompt = `
추천 종류: ${mode === "movie" ? "영화" : "도서"}
주제/분위기: ${topic || "(미입력)"}
이전에 좋아한 작품: ${history || "(미입력)"}
상황/조건: ${situation || "(미입력)"}

위 정보를 반영해 2~3개 추천해줘.
`.trim();

  // Gemini 응답 텍스트에서 JSON만 최대한 안정적으로 추출
  const extractJsonObject = (raw) => {
    if (!raw) return null;

    let cleaned = String(raw).trim();

    // ```json ... ``` / ``` ... ``` 제거
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    const jsonText = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  };

  try {
    // 네 ListModels 결과에 존재하는 모델 사용
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: systemHint + "\n\n" + userPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 700,
          // JSON 출력 모드(가능한 경우 가장 효과적)
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(`Gemini API error: ${errText}`, { status: 502 });
    }

    const geminiJson = await geminiRes.json();

    // Gemini 응답 텍스트 추출 (parts가 여러 개일 수 있음)
    const text =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim() ?? "";

    const parsed = extractJsonObject(text);
    if (!parsed) {
      // 디버깅이 필요하면 아래를 임시로 켜서 raw 텍스트를 확인할 수 있음(배포 시에는 끄는 것 권장)
      // return new Response(JSON.stringify({ error: "Model did not return JSON", raw: text }), { status: 502 });
      return new Response("Model did not return JSON", { status: 502 });
    }

    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 3) : [];

    const enriched = items
      .map((it) => {
        const title = (it?.title ?? "").toString().trim();
        const creator = (it?.creator ?? "").toString().trim();
        const year = (it?.year ?? "").toString().trim();
        const reason = (it?.reason ?? "").toString().trim();

        const q = [title, creator, year].filter(Boolean).join(" ").trim();

        return {
          title,
          creator,
          year,
          reason,
          externalUrl: makeExternalUrl(title || q),
          detailUrl: makeDetailUrl(q || title),
        };
      })
      .filter((x) => x.title);

    return new Response(
      JSON.stringify({
        mode,
        items: enriched,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (e) {
    return new Response(`Server exception: ${e.message}`, { status: 500 });
  }
};
