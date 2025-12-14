// netlify/functions/recommend.js

export default async (req) => {
  // 1. 요청 메서드 확인
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // 2. API Key 확인
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("API Key missing");
    return new Response("Missing GEMINI_API_KEY", { status: 500 });
  }

  // 3. Body 파싱
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

  // 링크 생성 헬퍼
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

  // 프롬프트
  const prompt = `
너는 ${mode === "movie" ? "영화" : "도서"} 추천 전문가다.
사용자의 취향에 맞춰 **실존하는 작품** 3개를 추천해줘.

[사용자 입력]
- 장르/분위기: ${moodGenre || "(없음)"}
- 주제: ${theme || "(없음)"}
- ${watchedLabel}: ${watched || "(없음)"}
- ${creatorLabel}: ${creatorName || "(없음)"}
- 자유 조건: ${constraints || "(없음)"}

[출력 형식]
반드시 아래와 같은 **JSON Array** 포맷으로 출력해. 
[
  { "title": "작품제목1", "reason": "이 작품을 추천하는 구체적인 이유 한 문장", "creator": "감독또는저자", "year": "출시년도(숫자만)" },
  ...
]

[규칙]
1. ${watchedLabel}와 유사한 결을 가진 작품을 우선 추천.
2. 없는 작품을 지어내지 말 것.
3. 한국어로 출력할 것.
`.trim();

  try {
    // ★수정 1: 모델을 1.5-flash로 변경 (하루 1500회 무료, 2.5는 20회 제한)
    const model = "models/gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // ★수정 2: 안전 설정 추가 (이게 없으면 AI가 빈 응답을 보내서 JSON 에러가 발생함)
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        // JSON 응답 강제 (1.5 Flash 기능)
        generationConfig: { 
          temperature: 0.7, 
          maxOutputTokens: 1000,
          responseMimeType: "application/json" 
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Gemini API Error:", errText);
      throw new Error(`Gemini API error: ${errText}`);
    }

    const json = await res.json();
    let rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    
    // 마크다운 제거 (혹시 모를 에러 방지)
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    console.log("AI Response:", rawText); // 디버깅용 로그

    let recommendations = [];
    try {
      recommendations = JSON.parse(rawText);
    } catch (e) {
      console.error("JSON Parse Error:", e);
      recommendations = [];
    }

    // 결과 매핑
    const items = recommendations.map((item) => {
      const q = [item.title, item.creator].filter(Boolean).join(" ").trim();
      return {
        title: item.title,
        creator: item.creator || "",
        year: item.year || "",
        reason: item.reason || "사용자 맞춤 추천입니다.",
        externalUrl: makeExternalUrl(q),
        detailUrl: makeDetailUrl(q),
      };
    });

    // 결과가 없으면 에러 처리 -> catch 블록의 Fallback으로 이동
    if (items.length === 0) {
      throw new Error("No items returned from AI");
    }

    return new Response(JSON.stringify({ mode, items }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  } catch (error) {
    console.error("Final Error Handler:", error);
    
    // Fallback 로직 (AI 실패 시 기본 추천)
    const fallbackTitles = mode === "movie" 
      ? ["쇼생크 탈출", "인셉션", "라라랜드"] 
      : ["데미안", "어린왕자", "미움받을 용기"];

    const fallbackItems = fallbackTitles.map(title => ({
      title: title,
      creator: "",
      year: "",
      reason: "AI 응답이 지연되어 기본 추천 목록을 보여드립니다.",
      externalUrl: makeExternalUrl(title),
      detailUrl: makeDetailUrl(title)
    }));

    return new Response(JSON.stringify({ mode, items: fallbackItems, note: "fallback" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};