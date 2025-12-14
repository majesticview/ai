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

  // 링크 생성
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

  // 텍스트 응답 파서:
  // 한 줄 형식: "제목 | creator=... | year=... | reason=..."
  // creator/year는 생략 가능. reason은 필수(모델에 강제)
  const parseLinesToItems = (rawText) => {
    if (!rawText) return [];
    let text = String(rawText).trim();

    // 코드블록 제거
    text = text.replace(/^```(?:text|json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 6); // 혹시 모델이 더 주면 잘라냄

    const items = [];
    for (const line0 of lines) {
      // 번호 제거: "1. ..." "1) ..." "- ..."
      const line = line0.replace(/^\s*(?:\d+[\.\)]\s*|[-•]\s*)/, "").trim();

      // 구분자 기반 파싱
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;

      const title = (parts[0] ?? "").trim();
      let creator = "";
      let year = "";
      let reason = "";

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const lower = p.toLowerCase();

        if (lower.startsWith("creator=")) creator = p.slice("creator=".length).trim();
        else if (lower.startsWith("author=")) creator = p.slice("author=".length).trim(); // 혹시 도서
        else if (lower.startsWith("director=")) creator = p.slice("director=".length).trim(); // 혹시 영화
        else if (lower.startsWith("year=")) year = p.slice("year=".length).trim();
        else if (lower.startsWith("reason=")) reason = p.slice("reason=".length).trim();
        else {
          // reason=을 빼먹는 경우 대비: 남는 조각을 reason에 합치기
          reason = reason ? `${reason} ${p}` : p;
        }
      }

      // 최소 제목은 있어야 함
      if (!title) continue;

      items.push({
        title,
        creator,
        year,
        reason,
        externalUrl: makeExternalUrl(title),
        detailUrl: makeDetailUrl([title, creator, year].filter(Boolean).join(" ")),
      });

      if (items.length >= 3) break;
    }

    return items;
  };

  // 프롬프트: JSON 금지, 오직 라인 규격만 출력
  const systemHint = `
너는 콘텐츠 추천 엔진이다.
반드시 아래 "라인 포맷"으로만 출력한다.
설명 문장, 인사, 머리말/꼬리말, 코드블록(\`\`\`) 금지.
총 2~3줄만 출력.

라인 포맷(정확히 이대로):
제목 | creator=작성자또는감독 | year=연도(모르면비움) | reason=추천이유(짧게 1~2문장)

주의:
- 구분자는 반드시 "|" 를 사용
- creator/year는 모르면 빈 값으로 두되 키는 유지: year=
- reason은 반드시 포함
`.trim();

  const userPrompt = `
추천 종류: ${mode === "movie" ? "영화" : "도서"}
주제/분위기: ${topic || "(미입력)"}
이전에 좋아한 작품: ${history || "(미입력)"}
상황/조건: ${situation || "(미입력)"}

위 정보를 반영해 추천 2~3개를 라인 포맷으로 출력해줘.
`.trim();

  try {
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // systemInstruction이 지원되는 경우 더 잘 따르지만, 미지원이어도 안전하게 user에 합쳐서 보냄
        contents: [
          { role: "user", parts: [{ text: systemHint + "\n\n" + userPrompt }] }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 600
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(`Gemini API error: ${errText}`, { status: 502 });
    }

    const geminiJson = await geminiRes.json();
    const text =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim() ?? "";

    const items = parseLinesToItems(text);

    if (items.length < 2) {
      // 실패 시, 원인 파악용 메시지(운영 때는 raw 노출을 줄이는 게 좋음)
      return new Response(
        JSON.stringify({ error: "Failed to parse recommendations", raw: text }),
        { status: 502, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    return new Response(
      JSON.stringify({ mode, items }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } catch (e) {
    return new Response(`Server exception: ${e.message}`, { status: 500 });
  }
};
