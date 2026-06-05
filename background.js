/*
  =====================================================================
  background.js
  =====================================================================

  이 파일은 확장 프로그램의 "두뇌" 역할을 합니다.
  사용자가 보는 웹페이지와는 완전히 분리된 별도 공간(Service Worker)에서
  조용히 실행되며, 다음 세 가지 핵심 역할을 담당합니다.

  1. content.js에서 "이 링크 분석해줘"라는 요청을 받으면
     실제로 Groq AI API를 호출해서 분석 결과를 돌려줍니다.

  2. 분석 진행 상황(단계)을 저장소에 저장해두고,
     action_popup.js가 요청하면 현재 상태를 알려줍니다.

  3. 같은 링크를 반복 분석하지 않도록 결과를 메모리에 보관합니다(캐시).

  ★ 다른 파일과의 관계
     - content.js      →  background.js 에게 분석 요청을 보냄
     - action_popup.js →  background.js 에게 현재 상태를 물어봄
     - background.js   →  두 파일 모두에게 응답하고 상태를 전달함

  =====================================================================
*/


// ─────────────────────────────────────────────
// 프로그램 전체에서 바뀌지 않는 고정 값들
// ─────────────────────────────────────────────

// Groq AI에 분석 요청을 보낼 주소 (URL)
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// 사용할 AI 모델의 이름 (Llama 3.1 8B 모델)
const GROQ_MODEL = "llama-3.1-8b-instant";

const CEREBRAS_ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

const CEREBRAS_MODEL = "gpt-oss-120b";

// 캐시(기억)를 얼마나 오래 유지할지: 6시간을 밀리초로 표현
// 계산: 1000ms(1초) × 60(1분) × 60(1시간) × 6(6시간)
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

// 브라우저 저장소에 상태를 저장할 때 사용하는 이름표(키)
const STATUS_STORAGE_KEY = "currentAnalysisStatus";

const AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY = "aiActiveCredentialIndex";

// 분석 결과를 임시로 보관하는 메모리 저장소 (Map = 키-값 쌍을 저장하는 자료구조)
// 키: URL 문자열, 값: 해당 URL의 분석 결과 + 저장 시각
// ※ 주의: Service Worker가 절전 상태로 종료되면 이 데이터도 같이 사라집니다.
const analysisCache = new Map();

try {
  importScripts("known_news_patterns.js");
} catch (error) {
  self.KNOWN_NEWS_URL_PREFIXES = [];
}


// ─────────────────────────────────────────────
// 확장 프로그램이 설치되거나 업데이트될 때 딱 한 번 실행
// ─────────────────────────────────────────────

/*
  chrome.runtime.onInstalled: 확장 프로그램이 브라우저에 처음 설치되거나
  버전이 업데이트될 때 자동으로 호출되는 이벤트입니다.
  여기서는 저장소에 초기 상태를 기록해 둡니다.
  이렇게 해두면 사용자가 아직 아무 링크에도 마우스를 올리지 않은 상태에서
  팝업을 열어도 "대기 중" 메시지가 정상적으로 표시됩니다.
*/
chrome.runtime.onInstalled.addListener(() => {
  updateStatus({
    stage: "idle",       // 현재 단계: 대기 중
    label: "대기 중",
    url: "",             // 분석 중인 URL 없음
    detail: "링크 위에 마우스를 1초 동안 올려두면 시작합니다."
  });
});


// ─────────────────────────────────────────────
// 다른 파일에서 보내는 메시지를 받아 처리하는 핵심 창구
// ─────────────────────────────────────────────

/*
  chrome.runtime.onMessage.addListener: content.js나 action_popup.js가
  chrome.runtime.sendMessage()로 메시지를 보낼 때마다 이 함수가 호출됩니다.
  마치 콜센터 교환원처럼, 어떤 종류의 요청인지 확인하고 알맞은 처리를 합니다.

  매개변수 설명:
    message     - 보내온 메시지 객체. type(요청 종류)과 payload(데이터)를 담고 있음
    sender      - 메시지를 보낸 쪽 정보. 어느 탭에서 왔는지 등을 알 수 있음
    sendResponse - "이 함수를 호출하면 메시지를 보낸 쪽에 결과가 전달됨"

  반환값의 의미:
    return false → 응답을 즉시 보내고 끝냄 (동기 처리)
    return true  → 나중에 비동기로 응답할 것임을 브라우저에게 알림 (채널 유지)
                   이 값을 빠뜨리면 비동기 응답이 도착하기 전에 채널이 닫혀 오류 발생
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── 요청 종류 1: content.js가 현재 분석 단계를 알려줄 때 ──
  // content.js는 마우스 이벤트가 발생할 때마다 현재 단계를 여기로 전송합니다.
  // message?.type 의 ?. 는 "message가 null이나 undefined여도 오류 내지 말고 undefined를 반환해"라는 표현입니다.
  if (message?.type === "STATUS_UPDATE") {
    updateStatus({
      stage:  message.payload?.stage  || "idle",   // 단계 (없으면 "idle")
      label:  message.payload?.label  || "대기 중", // 화면에 표시할 텍스트
      url:    message.payload?.url    || "",         // 분석 중인 URL
      tabId:  sender.tab?.id          || null        // 어느 탭에서 보낸 메시지인지
    });
    sendResponse({ ok: true }); // "잘 받았어" 라고 즉시 응답
    return false;               // 동기 처리이므로 false 반환
  }

  // ── 요청 종류 2: action_popup.js가 팝업을 열면서 현재 상태를 요청할 때 ──
  // 팝업이 열리는 순간 "지금 뭐 하고 있어?"를 물어보는 것입니다.
  if (message?.type === "GET_CURRENT_STATUS") {
    // getStoredStatus()는 저장소 읽기가 완료된 후 결과를 줍니다 (비동기).
    // .then(결과 => ...) : 읽기가 완료되면 이 함수를 실행하라는 뜻입니다.
    getStoredStatus().then((status) => sendResponse({ ok: true, status }));
    return true; // 비동기 응답을 사용하므로 반드시 true 반환
  }

  // 위 두 가지가 아닌 알 수 없는 메시지는 무시
  if (message?.type === "CHECK_KNOWN_NEWS_LINK") {
    const url = normalizeUrl(message.payload?.url || "");
    sendResponse({ ok: true, is_known_news: isKnownNewsUrl(url) });
    return false;
  }

  if (message?.type !== "ANALYZE_NEWS_LINK") {
    return false;
  }

  // ── 요청 종류 3: content.js가 "이 링크 분석해줘"라고 요청할 때 ──
  // handleAnalyzeRequest()가 실제 분석을 수행합니다.
  // .then() : 분석이 성공하면 결과를 응답으로 보냄
  // .catch(): 분석 도중 오류가 나면 오류 내용을 응답으로 보냄
  handleAnalyzeRequest(message.payload, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      const messageText = error.message || "분석 중 오류가 발생했습니다.";
      // 오류 상태도 저장해서 팝업에 표시될 수 있게 함
      updateStatus({
        stage: "error",
        label: "오류 발생",
        url:   message.payload?.url || "",
        detail: messageText,
        tabId: sender.tab?.id || null
      });
      sendResponse({ ok: false, error: messageText });
    });

  return true; // 분석은 시간이 걸리므로 비동기 응답 → true 반환
});


// ─────────────────────────────────────────────
// 링크 하나를 분석하는 전체 과정을 순서대로 실행하는 함수
// ─────────────────────────────────────────────

/*
  handleAnalyzeRequest: 분석 요청을 받아 완료까지 이끄는 함수입니다.
  async 키워드가 붙어 있어서 내부에서 await를 사용할 수 있습니다.
  await는 "이 작업이 끝날 때까지 기다린 후 다음 줄로 넘어가라"는 의미입니다.

  전체 흐름:
    ① URL 유효성 검사
    ② 캐시(이전 결과)가 있으면 바로 반환
    ③ API 키 확인
    ④ 기사 본문 다운로드 및 추출
    ⑤ AI에게 "뉴스 기사가 맞아?"라고 1차 질문
    ⑥ 기사가 맞으면 AI에게 신뢰도·어그로도 분석 요청
    ⑦ 결과를 캐시에 저장하고 반환

  매개변수:
    payload - content.js가 보낸 {url, link_text, force_refresh} 객체
    sender  - 메시지를 보낸 탭 정보
*/
async function handleAnalyzeRequest(payload, sender) {
  // URL을 표준 형식으로 정리 (해시 제거 등)
  const url   = normalizeUrl(payload?.url || "");
  const tabId = sender.tab?.id || null;

  // URL이 비어 있거나 올바르지 않으면 분석 불가능 → 오류 발생시켜 중단
  // throw new Error()는 "문제가 생겼으니 catch 쪽으로 넘겨라"는 신호입니다.
  if (!url) {
    throw new Error("분석할 URL이 올바르지 않습니다.");
  }

  // 팝업에 "링크 인식" 단계 표시
  updateStatus({ stage: "link_detected", label: "링크 인식", url, tabId });

  // force_refresh가 true면 캐시를 무시하고 새로 분석
  // force_refresh가 false(기본값)이면 캐시에 결과가 있는지 먼저 확인
  const cached = payload?.force_refresh ? null : getCachedResult(url);
  if (cached) {
    // 캐시된 결과가 있으면 AI 호출 없이 바로 반환 (빠르고 API 사용량 절약)
    updateStatus({
      stage: "complete",
      label: "캐시 결과 표시",
      url,
      detail: "같은 URL의 이전 분석 결과를 표시합니다.",
      tabId
    });
    return cached;
  }

  // 브라우저 저장소에서 Groq API 키를 가져옴
  const credentials = await getAiCredentials();
  if (!credentials.length) {
    // API 키가 없으면 분석 불가 → 사용자에게 설정 안내
    throw new Error("API Key를 options에서 설정하세요.");
  }

  // 팝업에 "본문 가져오는 중" 단계 표시 후, 해당 URL의 HTML을 실제로 다운로드해서 본문 추출
  updateStatus({ stage: "extracting", label: "본문 정보 가져오는 중", url, tabId });
  const extracted = await fetchArticlePreview(url);

  // AI에게 넘길 입력 데이터를 하나의 객체로 정리
  // truncate()는 텍스트가 너무 길면 잘라냄 (AI 입력 한도 때문에)
  const analysisInput = {
    url,
    link_text:         truncate(payload?.link_text        || "", 500),
    page_title:        truncate(extracted.page_title,          500),
    meta_description:  truncate(extracted.meta_description,   1000),
    og_title:          truncate(extracted.og_title,            500),
    article_text:      truncate(extracted.article_text,       6000),
    extraction_error:  truncate(extracted.extraction_error,    500)
  };

  // 팝업에 "뉴스 판별 중" 단계 표시 후, AI에게 1차 판별 요청
  // validateArticleCheck()는 AI 응답이 예상 형식인지 검사하고 정제
  updateStatus({ stage: "news_checking", label: "뉴스인지 판별 중", url, tabId });
  const skipArticleCheck = Boolean(payload?.skip_article_check);
  const articleCheck = skipArticleCheck
    ? { is_article: true, confidence: 100, reason: "알려진 언론사 기사 URL 패턴과 일치" }
    : validateArticleCheck(await requestArticleCheck(credentials, analysisInput));

  // AI가 "뉴스 기사가 아니다"라고 판단한 경우
  if (!articleCheck.is_article) {
    const result = buildNotArticleResult(articleCheck); // 빈 점수 결과 객체 생성
    setCachedResult(url, result);                        // 이것도 캐시에 저장
    updateStatus({
      stage: "not_article",
      label: "뉴스 기사 아님",
      url,
      detail: articleCheck.reason,
      tabId
    });
    return result; // 분석 없이 반환
  }

  // 뉴스 기사가 맞다고 판별됐으면 신뢰도·어그로도 본 분석 진행
  updateStatus({ stage: "analyzing", label: "뉴스 신뢰도·어그로도 분석 중", url, tabId });
  const analysis  = await requestGroqAnalysis(credentials, analysisInput);
  // validateAnalysis()는 점수를 유효 범위로 보정하고 텍스트를 정제
  const validated = validateAnalysis(analysis);

  // 분석 결과를 캐시에 저장 (6시간 동안 같은 URL 재분석 시 재사용)
  setCachedResult(url, validated);

  // 최종 완료 상태 표시
  updateStatus({
    stage: "complete",
    label: "분석 완료",
    url,
    detail: `신뢰도 ${validated.credibility_score}/100, 어그로도 ${validated.clickbait_score}/100`,
    tabId
  });

  return validated; // content.js에게 최종 결과 전달
}


// ─────────────────────────────────────────────
// 현재 분석 상태를 저장하고, 해당 탭에 알리는 함수
// ─────────────────────────────────────────────

/*
  updateStatus: 지금 어느 단계를 진행 중인지를
  ① 브라우저 저장소에 기록하고 (action_popup.js가 나중에 읽을 수 있도록)
  ② 현재 분석 중인 탭의 content.js에도 직접 메시지로 전달합니다.

  이 함수를 통해 팝업의 단계 표시가 실시간으로 업데이트됩니다.

  매개변수 status 객체의 구성:
    stage   - 단계 식별자 (예: "analyzing", "complete")
    label   - 화면에 보여줄 텍스트 (예: "분석 중")
    url     - 현재 분석 중인 링크 주소
    detail  - 부가 설명 (선택)
    tabId   - 메시지를 보낼 탭 번호 (없으면 null)
*/
function updateStatus(status) {
  // 빠진 항목은 기본값으로 채워서 항상 완전한 객체가 저장되도록 함
  const nextStatus = {
    stage:     status.stage     || "idle",
    label:     status.label     || "대기 중",
    url:       status.url       || "",
    detail:    status.detail    || "",
    tabId:     status.tabId     || null,
    updatedAt: Date.now()        // 현재 시각을 밀리초로 기록 (업데이트 시간 표시용)
  };

  // chrome.storage.local.set: 브라우저의 로컬 저장소에 데이터를 저장합니다.
  // [STATUS_STORAGE_KEY]는 변수를 키 이름으로 사용하는 문법입니다.
  // 저장된 데이터는 확장 프로그램이 꺼졌다 켜져도 유지됩니다.
  chrome.storage.local.set({ [STATUS_STORAGE_KEY]: nextStatus });

  // tabId가 있다면 해당 탭의 content.js에도 즉시 메시지 전송
  // content.js는 이 메시지를 받아 로딩 팝업의 텍스트를 실시간으로 바꿉니다.
  if (nextStatus.tabId) {
    chrome.tabs.sendMessage(nextStatus.tabId, {
      type: "STATUS_BROADCAST",
      status: nextStatus
    }).catch(() => {}); // 탭이 이미 닫혔거나 content.js가 없으면 오류를 그냥 무시
  }
}


// ─────────────────────────────────────────────
// 브라우저 저장소에서 현재 상태를 읽어오는 함수
// ─────────────────────────────────────────────

/*
  getStoredStatus: action_popup.js가 팝업을 열 때 "지금 상태가 뭐야?"를 물어보면
  저장소에서 상태 데이터를 꺼내서 돌려주는 함수입니다.

  chrome.storage.local.get은 콜백 방식으로 동작하는데,
  이를 Promise로 감싸서 await와 함께 쓸 수 있도록 변환했습니다.
  Promise는 "이 작업이 끝나면 결과를 줄게"라는 약속 객체입니다.
*/
function getStoredStatus() {
  return new Promise((resolve) => {
    // 저장소에서 STATUS_STORAGE_KEY에 해당하는 값을 가져옴
    // items는 { currentAnalysisStatus: { stage: ..., label: ... } } 형태
    chrome.storage.local.get([STATUS_STORAGE_KEY], (items) => {
      // 저장된 값이 있으면 그것을 반환하고, 없으면 기본 초기값 반환
      resolve(items[STATUS_STORAGE_KEY] || {
        stage:     "idle",
        label:     "대기 중",
        url:       "",
        detail:    "링크 위에 마우스를 1초 동안 올려두면 시작합니다.",
        updatedAt: Date.now()
      });
    });
  });
}


// ─────────────────────────────────────────────
// 브라우저 저장소에서 Groq API 키를 읽어오는 함수
// ─────────────────────────────────────────────

/*
  getGroqApiKey: options.js가 저장해둔 Groq API 키를 꺼내옵니다.
  API 키는 options.html 설정 페이지에서 사용자가 직접 입력해서 저장한 값입니다.
  키가 없거나 문자열이 아닌 값이면 빈 문자열을 반환합니다.
*/
function getAiCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["groqApiKey", "groqApiKeys", "cerebrasApiKeys"], (items) => {
      const groqKeys = Array.isArray(items.groqApiKeys)
        ? items.groqApiKeys
        : [];
      const legacyKeys = typeof items.groqApiKey === "string"
        ? [items.groqApiKey]
        : [];
      const cerebrasKeys = Array.isArray(items.cerebrasApiKeys)
        ? items.cerebrasApiKeys
        : [];

      resolve([
        ...normalizeApiKeys([...groqKeys, ...legacyKeys]).map((key) => ({
          provider: "Groq",
          key,
          endpoint: GROQ_ENDPOINT,
          model: GROQ_MODEL
        })),
        ...normalizeApiKeys(cerebrasKeys).map((key) => ({
          provider: "Cerebras",
          key,
          endpoint: CEREBRAS_ENDPOINT,
          model: CEREBRAS_MODEL
        }))
      ]);
    });
  });
}


// ─────────────────────────────────────────────
// 주어진 URL의 HTML을 다운로드해서 기사 본문 정보를 추출하는 함수
// ─────────────────────────────────────────────

/*
  fetchArticlePreview: 링크 주소(URL)로 직접 접속해서 HTML 문서를 받아온 뒤
  제목, 메타 설명, OG 제목, 본문 텍스트 등 분석에 필요한 정보를 꺼냅니다.
  접속 실패나 HTML이 아닌 경우에도 오류를 내지 않고 빈 값을 반환합니다.

  반환 객체:
    page_title       - <title> 태그 내용
    meta_description - <meta name="description"> 내용
    og_title         - <meta property="og:title"> 내용 (SNS 공유용 제목)
    article_text     - <p> 태그들에서 추출한 본문 텍스트
    extraction_error - 추출 중 오류가 발생했을 때의 오류 메시지
*/
async function fetchArticlePreview(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",    // 로그인 쿠키 등을 포함하지 않음 (보안 및 프라이버시)
      cache: "force-cache"    // 브라우저에 이미 캐시된 HTML이 있으면 재사용
    });

    // response.ok: HTTP 상태 코드가 200~299 사이일 때 true
    // 404(페이지 없음), 500(서버 오류) 등은 false
    if (!response.ok) {
      throw new Error(`본문 요청 실패 (${response.status})`);
    }

    // Content-Type 헤더로 HTML 문서인지 확인 (이미지, PDF 등은 파싱 불필요)
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("HTML 문서가 아닙니다.");
    }

    // HTML 전체를 하나의 문자열로 읽어옴
    const html = await response.text();

    return {
      page_title:       extractTitle(html),
      meta_description: extractMetaContent(html, "name", "description"),
      og_title:         extractMetaContent(html, "property", "og:title"),
      article_text:     extractArticleText(html),
      extraction_error: ""
    };
  } catch (error) {
    // 어떤 이유로든 본문을 가져오지 못하면 빈 값들을 반환
    // 분석 자체는 링크 텍스트나 URL만으로도 진행할 수 있으므로 중단하지 않음
    return {
      page_title:       "",
      meta_description: "",
      og_title:         "",
      article_text:     "",
      extraction_error: error instanceof Error ? error.message : "본문을 가져오지 못했습니다."
    };
  }
}


// ─────────────────────────────────────────────
// AI에게 뉴스 기사 여부를 판별해달라고 요청하는 함수 (1차 분류)
// ─────────────────────────────────────────────

/*
  requestArticleCheck: 분석 전에 먼저 "이게 뉴스 기사가 맞아?"를 AI에게 물어봅니다.
  쇼핑 페이지, 검색 결과, SNS 글, 카테고리 목록 등은 신뢰도 분석 대상이 아니기 때문입니다.

  내부적으로 requestGroqJson()을 호출하며,
  system 역할에는 AI가 어떻게 판단해야 하는지 지침(프롬프트)을,
  user 역할에는 실제 기사 데이터를 전달합니다.
*/
async function requestArticleCheck(credentials, payload) {
  return requestGroqJson(credentials, [
    {
      role: "system",
      // buildArticleCheckPrompt()는 AI에게 주는 역할 지침 문자열을 반환
      content: buildArticleCheckPrompt()
    },
    {
      role: "user",
      // JSON.stringify(payload, null, 2): 객체를 보기 좋게 들여쓴 JSON 문자열로 변환
      content: JSON.stringify(payload, null, 2)
    }
  ]);
}


// ─────────────────────────────────────────────
// AI에게 신뢰도·어그로도 분석을 요청하는 함수 (본 분석)
// ─────────────────────────────────────────────

/*
  requestGroqAnalysis: 뉴스 기사로 판별된 링크에 대해
  신뢰도 점수, 어그로도 점수, 세부 항목 점수, 요약 등을 AI에게 요청합니다.
  requestArticleCheck와 구조는 동일하지만 다른 프롬프트를 사용합니다.
*/
async function requestGroqAnalysis(credentials, payload) {
  return requestGroqJson(credentials, [
    {
      role: "system",
      content: buildAnalysisPrompt()
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2)
    }
  ]);
}


// ─────────────────────────────────────────────
// Groq AI API를 실제로 호출하고 응답을 JSON으로 반환하는 함수
// ─────────────────────────────────────────────

/*
  requestGroqJson: 위의 두 요청 함수(requestArticleCheck, requestGroqAnalysis)가
  공통으로 사용하는 실제 API 통신 함수입니다.
  HTTP POST 요청을 보내고, 응답을 JSON 객체로 파싱해서 반환합니다.

  매개변수:
    apiKey   - Groq API 인증 키
    messages - AI에게 전달할 대화 메시지 배열 [{role, content}, ...]

  AI 응답 구조 (Groq API 형식):
    {
      choices: [
        {
          message: {
            content: "{ ...JSON 형태의 분석 결과 문자열... }"
          }
        }
      ]
    }
*/
async function requestGroqJson(credentials, messages) {
  const candidates = Array.isArray(credentials) ? credentials : [];
  const startIndex = await getActiveCredentialIndex(candidates.length);
  let lastError = null;

  for (let offset = 0; offset < candidates.length; offset += 1) {
    const index = (startIndex + offset) % candidates.length;
    try {
      const result = await requestGroqJsonWithCredential(candidates[index], messages);
      await setActiveCredentialIndex(index);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableGroqError(error) || offset === candidates.length - 1) {
        if (offset === candidates.length - 1) {
          await setActiveCredentialIndex((index + 1) % candidates.length);
        }
        throw error;
      }
      await setActiveCredentialIndex((index + 1) % candidates.length);
    }
  }

  throw lastError || new Error("사용할 수 있는 AI API Key가 없습니다.");
}

async function requestGroqJsonWithCredential(credential, messages) {
  const response = await fetch(credential.endpoint, {
    method: "POST",
    headers: {
      // Authorization 헤더에 API 키를 "Bearer 키값" 형식으로 포함
      "Authorization": `Bearer ${credential.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model:           credential.model,
      temperature:     0.1,                        // 0에 가까울수록 일관성 있는 답변, 1에 가까울수록 창의적
      response_format: { type: "json_object" },    // AI가 반드시 JSON만 반환하도록 강제
      messages
    })
  });

  // HTTP 요청 자체가 실패한 경우 (네트워크 오류, 인증 실패 등)
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`${credential.provider} API 요청 실패 (${response.status}) ${truncate(errorText, 200)}`);
    error.status = response.status;
    throw error;
  }

  // 응답 본문을 JSON으로 파싱
  const data = await response.json();

  // data?.choices?.[0]?.message?.content
  // ?. 를 연속으로 사용해서 중간에 undefined가 있어도 오류 없이 undefined를 반환
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq API 응답이 비어 있습니다.");
  }

  try {
    // AI가 문자열로 반환한 JSON을 실제 JavaScript 객체로 변환
    return JSON.parse(content);
  } catch (error) {
    throw new Error("AI 응답을 JSON으로 해석하지 못했습니다.");
  }
}


// ─────────────────────────────────────────────
// AI에게 줄 지침(프롬프트) 생성 함수들
// ─────────────────────────────────────────────

/*
  buildArticleCheckPrompt: AI에게 "너는 뉴스 기사 판별기야"라고 역할을 부여하고
  어떤 형식으로 답해야 하는지 지정하는 지침 문자열을 반환합니다.
  백틱(`)으로 감싼 문자열은 여러 줄을 그대로 쓸 수 있는 템플릿 리터럴입니다.
  .trim()은 앞뒤 불필요한 줄바꿈을 제거합니다.
*/
function buildArticleCheckPrompt() {
  return `
너는 링크가 뉴스 기사인지 먼저 판별하는 분류기다.
제공된 URL, 링크 텍스트, title, meta, og:title, 본문 일부만 사용해 판단한다.
일반 쇼핑, 광고, 검색 결과, SNS 글, 영상 페이지, 게시판 목록, 언론사 홈, 카테고리 페이지는 뉴스 기사로 보지 않는다.
개별 사건이나 이슈를 다루는 기사 본문으로 보이면 뉴스 기사로 본다.
응답은 오직 JSON 객체 하나만 반환한다.

형식:
{
  "is_article": true,
  "confidence": 84,
  "reason": "개별 기사 제목과 본문 단락이 확인됨"
}
`.trim();
}

/*
  buildAnalysisPrompt: AI에게 신뢰도·어그로도 분석 기준과
  반환 형식을 상세하게 알려주는 지침 문자열을 반환합니다.
  각 항목의 배점 기준도 포함되어 있어 AI가 일관된 기준으로 채점하도록 유도합니다.
*/
function buildAnalysisPrompt() {
  return `
너는 뉴스 링크의 신뢰도와 어그로도를 평가하는 분석기다.
이미 뉴스 기사로 판별된 링크만 입력된다.
반드시 사용자가 제공한 제목, URL, 메타 정보, 본문 일부만 근거로 삼아라.
정보가 부족하면 임의로 사실을 추정하지 말고 낮은 확신을 반영해라.
article_summary는 기사 내용을 1문장으로 짧게 요약해라.
응답은 설명 문장 없이 오직 JSON 객체 하나만 반환해라.

[신뢰도 credibility_score: 0~100점]
- 출처 명확성: 20점
  기자명, 언론사, 작성일, 공식 출처 존재 여부
- 제목/본문 일치도: 25점
  제목이 본문 내용을 정확히 반영하는 정도
- 근거 충실도: 25점
  통계, 공식 발표, 전문가 인용, 자료 출처 존재 여부
- 표현 중립성: 15점
  감정적·선동적 표현이 적은 정도
- 맥락 제공성: 15점
  사건의 배경, 반대 의견, 한계, 추가 설명 제공 여부

[어그로도 clickbait_score: 0~100점]
높을수록 나쁨.
- 과장 표현: 20점
  "충격", "경악", "역대급", "난리", "소름" 같은 표현
- 궁금증 유도: 20점
  "알고 보니", "이유는?", "결과는?", "정체는?" 같은 표현
- 제목/본문 불일치: 25점
  제목이 본문보다 과장되거나 다른 인상을 주는 정도
- 감정 자극: 20점
  분노, 공포, 혐오, 불안, 논란을 과도하게 유도하는 정도
- 핵심 정보 은폐: 15점
  제목에서 중요한 주어·대상·결과를 숨기는 정도

아래 형식과 키를 그대로 사용해라.
{
  "is_article": true,
  "credibility_score": 72,
  "clickbait_score": 38,
  "credibility_breakdown": {
    "source_clarity": 15,
    "title_body_match": 20,
    "evidence_quality": 18,
    "neutrality": 10,
    "context": 9
  },
  "clickbait_breakdown": {
    "exaggeration": 8,
    "curiosity_gap": 10,
    "title_body_mismatch": 7,
    "emotional_trigger": 8,
    "hidden_key_info": 5
  },
  "article_summary": "정부 발표에 따른 정책 변화와 관련 반응을 다룬 기사입니다.",
  "summary": "공식 자료 인용은 있으나 제목에 약간의 클릭 유도 표현이 있음",
  "warning": "제목만 보고 판단하지 말고 본문 근거를 확인하세요."
}
`.trim();
}


// ─────────────────────────────────────────────
// AI 응답을 검사하고 안전한 값으로 정제하는 함수들
// ─────────────────────────────────────────────

/*
  validateArticleCheck: AI가 반환한 뉴스 판별 결과를 검증합니다.
  AI가 예상치 못한 형식으로 답하거나 값이 빠져 있어도
  이 함수가 항상 올바른 형태의 객체를 반환하도록 보장합니다.
*/
function validateArticleCheck(value) {
  return {
    // Boolean()으로 감싸서 어떤 값이 들어와도 true/false로 확실하게 변환
    is_article: Boolean(value?.is_article),
    confidence: clampScore(value?.confidence), // 0~100 범위로 보정
    // 이유 텍스트가 없거나 너무 길면 기본값 또는 잘라낸 값으로 대체
    reason: sanitizeText(value?.reason || "뉴스 기사 여부를 명확히 판단하기 어렵습니다.", 180)
  };
}

/*
  buildNotArticleResult: "뉴스 기사가 아님"으로 판별됐을 때
  모든 점수를 0으로 채운 결과 객체를 만들어 반환합니다.
  content.js는 is_article이 false인 객체를 받으면 "뉴스 기사 아님" 팝업을 표시합니다.
*/
function buildNotArticleResult(articleCheck) {
  return {
    is_article:      false,
    credibility_score: 0,
    clickbait_score:   0,
    credibility_breakdown: {
      source_clarity:  0,
      title_body_match: 0,
      evidence_quality: 0,
      neutrality:      0,
      context:         0
    },
    clickbait_breakdown: {
      exaggeration:       0,
      curiosity_gap:      0,
      title_body_mismatch: 0,
      emotional_trigger:  0,
      hidden_key_info:    0
    },
    summary: articleCheck.reason || "이 링크는 뉴스 기사로 보기 어렵습니다.",
    warning: "뉴스 기사로 판별된 링크만 신뢰도와 어그로도를 분석합니다."
  };
}

/*
  validateAnalysis: AI가 반환한 본 분석 결과를 검증하고 정제합니다.
  점수를 각 항목의 최대 점수 범위 안으로 강제로 맞추고,
  텍스트 필드는 길이를 제한하며 공백을 정리합니다.
  이 과정을 거쳐야 content.js에서 안전하게 화면에 출력할 수 있습니다.
*/
function validateAnalysis(value) {
  // 세부 항목 객체가 없으면 빈 객체로 대체해서 이후 접근 시 오류를 방지
  const credibilityBreakdown = value?.credibility_breakdown || {};
  const clickbaitBreakdown   = value?.clickbait_breakdown   || {};

  return {
    is_article:        true,
    credibility_score: clampScore(value?.credibility_score), // 전체 신뢰도 (0~100)
    clickbait_score:   clampScore(value?.clickbait_score),   // 전체 어그로도 (0~100)
    credibility_breakdown: {
      source_clarity:   clampScore(credibilityBreakdown.source_clarity,  20), // 최대 20점
      title_body_match: clampScore(credibilityBreakdown.title_body_match, 25), // 최대 25점
      evidence_quality: clampScore(credibilityBreakdown.evidence_quality, 25),
      neutrality:       clampScore(credibilityBreakdown.neutrality,       15),
      context:          clampScore(credibilityBreakdown.context,          15)
    },
    clickbait_breakdown: {
      exaggeration:        clampScore(clickbaitBreakdown.exaggeration,       20),
      curiosity_gap:       clampScore(clickbaitBreakdown.curiosity_gap,      20),
      title_body_mismatch: clampScore(clickbaitBreakdown.title_body_mismatch, 25),
      emotional_trigger:   clampScore(clickbaitBreakdown.emotional_trigger,  20),
      hidden_key_info:     clampScore(clickbaitBreakdown.hidden_key_info,    15)
    },
    article_summary: sanitizeText(value?.article_summary || "기사 요약을 생성하지 못했습니다.",  120),
    summary:         sanitizeText(value?.summary         || "분석 요약을 생성하지 못했습니다.",  180),
    warning:         sanitizeText(value?.warning         || "AI 판단은 참고용이며 최종 팩트체크가 아닙니다.", 180)
  };
}


// ─────────────────────────────────────────────
// HTML에서 필요한 정보를 꺼내는 파싱 함수들
// ─────────────────────────────────────────────

/*
  extractTitle: HTML 문자열에서 <title>...</title> 사이의 텍스트를 꺼냅니다.
  정규 표현식(regex)을 사용해서 태그를 찾습니다.
  /i 플래그는 대소문자 구분 없이 검색하겠다는 의미입니다.
*/
function extractTitle(html) {
  // .match()는 정규식과 일치하는 첫 번째 결과를 반환합니다.
  // [\\s\\S]*? 는 줄바꿈 포함 아무 문자나 (최대한 적게) 매칭하는 패턴입니다.
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // match?.[1] : 첫 번째 캡처 그룹 (괄호 안의 내용). 없으면 ""
  return decodeHtml(stripTags(match?.[1] || ""));
}

/*
  extractMetaContent: HTML에서 특정 <meta> 태그의 content 값을 추출합니다.
  예) extractMetaContent(html, "name", "description")
      → <meta name="description" content="기사 설명..."> 에서 "기사 설명..."을 반환

  매개변수:
    html           - HTML 전체 문자열
    attributeName  - 찾을 속성 이름 ("name" 또는 "property")
    attributeValue - 속성 값 ("description", "og:title" 등)
*/
function extractMetaContent(html, attributeName, attributeValue) {
  // HTML에서 모든 <meta ...> 태그를 배열로 추출. 없으면 빈 배열
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const normalizedAttributeName  = attributeName.toLowerCase();
  const normalizedAttributeValue = attributeValue.toLowerCase();

  // 모든 meta 태그를 하나씩 검사해서 원하는 태그를 찾음
  for (const tag of metaTags) {
    // parseAttributes()로 태그 속성을 {이름: 값} 객체로 변환
    const attributes = parseAttributes(tag);
    if ((attributes[normalizedAttributeName] || "").toLowerCase() === normalizedAttributeValue) {
      return decodeHtml(attributes.content || ""); // content 속성 값 반환
    }
  }

  return ""; // 해당하는 meta 태그가 없으면 빈 문자열 반환
}

/*
  extractArticleText: HTML에서 실제 기사 본문 텍스트를 추출합니다.
  우선 <article> 태그 안에서 찾고, 없으면 전체 HTML에서 <p> 태그를 수집합니다.
  30자 미만의 짧은 단락(메뉴 항목 등)은 제외하고, 최대 12개 단락만 사용합니다.
*/
function extractArticleText(html) {
  // <article>...</article> 블록 전체를 배열로 찾음 (본문이 여기 들어있는 경우가 많음)
  const articleMatches = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/gi) || [];
  // <article>이 있으면 그 안에서만 <p>를 찾고, 없으면 HTML 전체에서 찾음
  const sourceHtml     = articleMatches.length > 0 ? articleMatches.join("\n") : html;

  const paragraphMatches = sourceHtml.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  const paragraphs = paragraphMatches
    .map((paragraph) => decodeHtml(stripTags(paragraph))) // HTML 태그 제거 후 엔티티 디코딩
    .map((text) => text.replace(/\s+/g, " ").trim())      // 연속 공백을 하나로 정리
    .filter((text) => text.length >= 30)                   // 너무 짧은 단락 제거
    .slice(0, 12);                                          // 최대 12개 단락만 사용

  // 단락들을 줄바꿈으로 이어붙이고, 전체 5000자를 초과하면 잘라냄
  return paragraphs.join("\n").slice(0, 5000);
}

/*
  parseAttributes: HTML 태그 하나를 받아서 그 안의 모든 속성을 {이름: 값} 객체로 반환합니다.
  예) <meta name="description" content="설명">
      → { name: "description", content: "설명" }

  HTML 속성 값은 큰따옴표, 작은따옴표, 따옴표 없음 세 가지 방식이 있어서
  정규식이 세 경우를 모두 처리합니다.
*/
function parseAttributes(tag) {
  const attributes = {};
  // 정규식 설명:
  // ([a-zA-Z_:][-a-zA-Z0-9_:.]*) → 속성 이름 (캡처 그룹 1)
  // \s*=\s*                       → 등호 (앞뒤 공백 허용)
  // "([^"]*)"                     → 큰따옴표로 감싼 값 (캡처 그룹 3)
  // '([^']*)'                     → 작은따옴표로 감싼 값 (캡처 그룹 4)
  // ([^\s"'=<>`]+)                → 따옴표 없는 값 (캡처 그룹 5)
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match = regex.exec(tag);

  while (match) {
    // ?? (Nullish Coalescing): 왼쪽이 null/undefined이면 오른쪽 값 사용
    // 세 캡처 그룹 중 실제로 매칭된 것을 선택
    attributes[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
    match = regex.exec(tag); // 같은 태그에서 다음 속성으로 이동
  }

  return attributes;
}

/*
  stripTags: HTML 문자열에서 모든 태그를 제거하고 텍스트만 남깁니다.
  <script>와 <style> 블록은 그 안의 내용까지 통째로 제거합니다.
  나머지 태그(<p>, <span> 등)는 태그만 제거하고 안의 내용은 보존합니다.
*/
function stripTags(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ") // <script>...</script> 전체 제거
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,  " ") // <style>...</style>  전체 제거
    .replace(/<[^>]+>/g, " ");                            // 나머지 모든 태그를 공백으로 대체
}

/*
  decodeHtml: HTML 특수 문자 코드를 실제 문자로 변환합니다.
  예) &amp; → &, &lt; → <, &gt; → >, &quot; → ", &#39; → '
  웹에서 가져온 텍스트에는 이런 코드들이 섞여 있어서 정리가 필요합니다.
*/
function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")  // 줄바꿈 없는 공백
    .replace(/&amp;/gi,  "&")
    .replace(/&lt;/gi,   "<")
    .replace(/&gt;/gi,   ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi,  "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")     // 연속된 공백/줄바꿈을 하나의 공백으로
    .trim();                   // 앞뒤 공백 제거
}

function normalizeApiKeys(keys) {
  const seen = new Set();
  return keys
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .filter((key) => {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function isKnownNewsUrl(url) {
  const normalizedUrl = normalizeUrl(url).toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  const prefixes = Array.isArray(self.KNOWN_NEWS_URL_PREFIXES)
    ? self.KNOWN_NEWS_URL_PREFIXES
    : [];

  return prefixes.some((prefix) => normalizedUrl.startsWith(String(prefix || "").toLowerCase()));
}

function getActiveCredentialIndex(keyCount) {
  return new Promise((resolve) => {
    if (!keyCount) {
      resolve(0);
      return;
    }

    chrome.storage.local.get([AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY], (items) => {
      const index = Number(items[AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY]);
      resolve(Number.isInteger(index) && index >= 0 ? index % keyCount : 0);
    });
  });
}

function setActiveCredentialIndex(index) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY]: index }, resolve);
  });
}

function isRetryableGroqError(error) {
  const status = Number(error?.status);
  return [401, 403, 408, 409, 429, 500, 502, 503, 504].includes(status);
}


// ─────────────────────────────────────────────
// 범용 유틸리티 함수들 (여러 곳에서 공통으로 사용)
// ─────────────────────────────────────────────

/*
  clampScore: 숫자 값을 0 이상 max 이하 범위로 강제로 조정합니다.
  AI가 범위를 벗어난 값(예: 150점, -5점)을 반환해도 안전하게 처리됩니다.
  숫자가 아닌 값(undefined, 문자열 등)은 0으로 처리합니다.
  Math.round()로 소수점도 제거합니다.
*/
function clampScore(value, max = 100) {
  const number = Number(value); // 어떤 값이든 숫자로 변환 시도
  if (!Number.isFinite(number)) {
    return 0; // NaN(숫자 아님), Infinity(무한대) 등 비정상 값은 0 반환
  }
  return Math.max(0, Math.min(max, Math.round(number)));
}

/*
  normalizeUrl: URL을 표준 형식으로 정리합니다.
  http, https만 허용하고 나머지 프로토콜(ftp://, file:// 등)은 막습니다.
  URL 끝의 #anchor(페이지 내 위치 표시) 부분을 제거합니다.
  같은 기사를 #section1, #section2 등 다른 앵커로 접근해도 같은 URL로 취급하기 위함입니다.
  파싱에 실패하면 빈 문자열을 반환합니다.
*/
function normalizeUrl(url) {
  try {
    const parsed = new URL(url); // URL을 구성 요소(프로토콜, 호스트, 경로 등)로 분해
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return ""; // http/https 외 차단
    }
    parsed.hash = ""; // #anchor 제거
    return parsed.toString(); // 다시 문자열로 조합해서 반환
  } catch (error) {
    return ""; // URL 형식이 잘못된 경우
  }
}

/*
  getCachedResult: 메모리 캐시에서 해당 URL의 분석 결과를 찾아봅니다.
  결과가 있어도 저장된 지 6시간이 지났으면 삭제하고 null을 반환합니다.
  결과가 없으면 null을 반환합니다.
*/
function getCachedResult(url) {
  const cached = analysisCache.get(url); // Map에서 URL 키로 값을 가져옴

  if (!cached) {
    return null; // 캐시에 없음
  }

  // Date.now()는 현재 시각(밀리초), cached.savedAt은 저장된 시각
  // 차이가 CACHE_TTL_MS(6시간)를 넘으면 만료된 것으로 판단
  if (Date.now() - cached.savedAt > CACHE_TTL_MS) {
    analysisCache.delete(url); // 만료된 캐시 삭제
    return null;
  }

  return cached.data; // 유효한 캐시 반환
}

/*
  setCachedResult: 분석 결과를 현재 시각과 함께 메모리 캐시에 저장합니다.
  같은 URL을 6시간 이내에 다시 분석하면 AI 호출 없이 이 값을 재사용합니다.
*/
function setCachedResult(url, data) {
  analysisCache.set(url, {
    savedAt: Date.now(), // 저장 시각 기록 (TTL 계산용)
    data                 // 실제 분석 결과 객체
  });
}

/*
  sanitizeText: 문자열의 연속 공백을 하나로 정리하고,
  maxLength를 초과하면 truncate()로 잘라냅니다.
  AI 응답 텍스트를 화면에 표시하기 전에 정제할 때 사용합니다.
*/
function sanitizeText(value, maxLength) {
  return truncate(String(value).replace(/\s+/g, " ").trim(), maxLength);
}

/*
  truncate: 문자열이 maxLength보다 길면 그 길이에서 잘라내고 "..."를 붙입니다.
  짧으면 그대로 반환합니다.
  AI 입력 한도 초과를 방지하거나 UI에서 너무 긴 텍스트를 방지할 때 사용합니다.
*/
function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
