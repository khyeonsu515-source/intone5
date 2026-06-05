/*
  =====================================================================
  content.js
  =====================================================================

  이 파일은 사용자가 현재 보고 있는 웹페이지 위에서 직접 실행됩니다.
  쉽게 말하면, 이 코드가 뉴스 사이트, 포털 등 모든 웹페이지에 "몰래 끼어들어"
  링크에 마우스를 올렸을 때의 동작을 추가합니다.

  이 파일이 하는 일:
  1. 페이지의 모든 링크에 마우스가 올라가면 감지합니다.
  2. 1초 이상 머물면 background.js에 분석을 요청합니다.
  3. 분석 결과(또는 로딩/오류 상태)를 팝업 형태로 화면에 띄웁니다.
  4. 마우스가 링크에서 벗어나면 팝업을 닫습니다.

  ★ 다른 파일과의 관계
     - manifest.json이 "모든 웹페이지에 content.js를 심어라"고 지정합니다.
     - content.js는 background.js에게 분석 요청을 보내고 결과를 받습니다.
     - popup.css는 content.js가 만드는 팝업의 스타일을 담당합니다.
     - background.js가 보내는 STATUS_BROADCAST 메시지를 받아 팝업 텍스트를 업데이트합니다.

  =====================================================================
*/


// ─────────────────────────────────────────────
// 고정 상수
// ─────────────────────────────────────────────

// 마우스를 링크 위에 이 시간(ms) 동안 올려두면 분석을 시작
const HOVER_DELAY_MS = 1000;

const UNKNOWN_NEWS_DELAY_MS = 7000;

// AI에게 넘기는 링크 텍스트의 최대 길이 (토큰 절약용)
const MAX_LINK_TEXT_LENGTH = 300;

const POPUP_INTERACTION_GRACE_MS = 1000;


// ─────────────────────────────────────────────
// 전역 상태 변수 — 페이지에서 마우스 동작을 추적하기 위한 값들
// ─────────────────────────────────────────────

// setTimeout으로 만든 타이머의 ID. clearTimeout(hoverTimer)로 취소할 때 필요
let hoverTimer = null;

// 현재 마우스가 올라가 있는 <a> 링크 요소
let activeLink = null;

// 마우스가 마지막으로 움직인 이벤트. 팝업을 마우스 위치에 표시할 때 사용
let lastMouseEvent = null;

// 팝업 div 요소. 처음 한 번만 만들고 계속 재사용함
let popup = null;

// 요청 순번. 마우스가 빠르게 여러 링크를 지나갈 때 오래된 응답을 무시하기 위해 사용
// 새 요청을 보낼 때마다 1씩 증가하고, 응답이 도착했을 때 현재 번호와 일치하면 처리
let currentRequestId = 0;

let analysisStartedForActiveLink = false;

let suppressPopupMouseOutUntil = 0;

let popupGraceCloseTimer = null;

// 팝업이 현재 어느 좌표에 표시되고 있는지 기억해두는 값 {x, y}
// 창 크기 변경/스크롤 시 팝업 위치를 재계산할 때 사용
let popupAnchor = null;

let popupOpenPoint = null;


// ─────────────────────────────────────────────
// 마우스 이벤트 감지 등록
// ─────────────────────────────────────────────

/*
  document.addEventListener: 페이지 전체에서 마우스 이벤트를 감지합니다.
  세 번째 인수 true는 "캡처 단계"에서 처리하겠다는 의미입니다.
  캡처 단계란 이벤트가 부모 요소에서 자식 요소로 내려가는 단계를 말합니다.
  true를 쓰면 페이지의 다른 스크립트보다 먼저 이벤트를 받을 수 있어서
  일부 페이지에서 이벤트를 막는 경우에도 동작합니다.
*/
document.addEventListener("mouseover",  handleMouseOver, true);  // 마우스가 요소 위로 올라갈 때
document.addEventListener("mouseout",   handleMouseOut,  true);  // 마우스가 요소에서 벗어날 때
document.addEventListener("mousemove",  handleMouseMove, true);  // 마우스가 움직일 때

// 창 크기가 바뀌거나 스크롤될 때 팝업이 화면 밖으로 나가지 않도록 위치 재계산
window.addEventListener("resize", keepPopupInViewport);
window.addEventListener("scroll", keepPopupInViewport, true);

/*
  chrome.runtime.onMessage: background.js가 보내는 메시지를 여기서 받습니다.
  background.js는 분석 단계가 바뀔 때마다 STATUS_BROADCAST 메시지를 전송합니다.
  이 코드는 팝업이 열려 있을 때 로딩 텍스트를 실시간으로 업데이트합니다.
  예) "AI 분석 중..." → "뉴스 판별 중..." → "신뢰도 분석 중..."
*/
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "STATUS_BROADCAST") {
    return;
  }

  const status = message.status || {};

  if (status.stage === "analyzing" && isStatusForActiveLink(status) && getPopupOpenPoint()) {
    suppressPopupMouseOutUntil = Date.now() + 800;
    showLoadingPopupAtAnchor(status.label || "AI 분석 중...");
    return;
  }

  if (popup && !popup.hidden) {
    updateLoadingStatus(status.label || "처리 중...");
  }
});


// ─────────────────────────────────────────────
// 마우스 이벤트 핸들러 함수들
// ─────────────────────────────────────────────

/*
  handleMouseOver: 마우스가 페이지의 어떤 요소 위로 올라갈 때마다 호출됩니다.
  올라간 요소가 링크(<a href="...">)인지 확인하고,
  맞으면 1초짜리 타이머를 시작합니다.
  타이머가 끝나기 전에 마우스가 벗어나면(handleMouseOut) 타이머를 취소합니다.
*/
function handleMouseOver(event) {
  // event.target: 마우스가 올라간 실제 요소 (이미지, span 등일 수 있음)
  // .closest("a[href]"): 자기 자신 또는 부모 중에서 href 속성이 있는 <a> 태그를 찾음
  // 예) 링크 안의 이미지에 마우스를 올려도 감지됨
  const link = event.target.closest("a[href]");

  // 링크가 아니거나 DOM에서 분리된 유령 요소이면 아무것도 안 함
  if (!link || !document.documentElement.contains(link)) {
    return;
  }

  const href = link.href;
  // 정규 표현식 (/^https?:\/\//i)으로 http:// 또는 https://로 시작하는지 확인
  // javascript:, mailto: 등의 링크는 무시
  if (!href || !/^https?:\/\//i.test(href)) {
    return;
  }

  activeLink      = link;  // 현재 올라가 있는 링크를 기억
  lastMouseEvent  = event; // 마우스 위치를 팝업 표시에 사용
  popupOpenPoint  = null;
  analysisStartedForActiveLink = false;
  clearHoverTimer();       // 이전 타이머가 있으면 먼저 취소 (다른 링크로 빠르게 이동 시)

  // 1초 후 analyzeHoveredLink 실행 예약
  // window.setTimeout(함수, 시간): 지정한 시간(ms) 후에 함수를 실행
  hoverTimer = window.setTimeout(() => {
    handleInitialHoverDelay(link, event);
  }, HOVER_DELAY_MS);
}

/*
  handleMouseOut: 마우스가 요소에서 벗어날 때 호출됩니다.
  활성 링크에서 벗어난 경우 타이머를 취소하고 팝업을 닫습니다.
  단, 팝업 위로 이동하거나 링크 안의 자식 요소로 이동한 경우는 무시합니다.
*/
function handleMouseOut(event) {
  if (isPopupInteractionGraceActive()) {
    schedulePopupCloseAfterGrace();
    return;
  }

  const link = event.target.closest("a[href]");

  // 벗어난 요소가 현재 활성 링크가 아니면 무시
  if (!link || link !== activeLink) {
    return;
  }

  // event.relatedTarget: 마우스가 이동한 다음 요소
  // 팝업 위로 이동하거나 링크의 자식 요소로 이동한 경우 팝업을 유지
  if (event.relatedTarget && (link.contains(event.relatedTarget) || popup?.contains(event.relatedTarget))) {
    return;
  }

  closePopupFromPointerExit();
}

/*
  handleMouseMove: 마우스가 움직일 때마다 호출됩니다.
  실제로 어떤 처리를 하지는 않고, 마지막 마우스 위치만 기록합니다.
  팝업을 오류나 재분석 결과로 업데이트할 때 위치 계산에 사용됩니다.
*/
function handleMouseMove(event) {
  lastMouseEvent = event;
}

/*
  clearHoverTimer: 1초 타이머를 취소합니다.
  window.clearTimeout()에 타이머 ID를 넘기면 예약된 실행이 취소됩니다.
*/
function clearHoverTimer() {
  if (hoverTimer) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function handleInitialHoverDelay(link, event) {
  hoverTimer = null;
  if (activeLink !== link) {
    return;
  }

  checkKnownNewsLink(link.href, (isKnownNews) => {
    if (activeLink !== link) {
      return;
    }

    if (isKnownNews) {
      analyzeHoveredLink(link, event, { skipArticleCheck: true });
      return;
    }

    hoverTimer = window.setTimeout(() => {
      if (activeLink === link) {
        analyzeHoveredLink(link, event);
      }
    }, Math.max(0, UNKNOWN_NEWS_DELAY_MS - HOVER_DELAY_MS));
  });
}

function checkKnownNewsLink(url, callback) {
  chrome.runtime.sendMessage(
    {
      type: "CHECK_KNOWN_NEWS_LINK",
      payload: { url }
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        callback(false);
        return;
      }
      callback(Boolean(response.is_known_news));
    }
  );
}


// ─────────────────────────────────────────────
// 실제 분석을 요청하는 핵심 함수
// ─────────────────────────────────────────────

/*
  analyzeHoveredLink: 1초 이상 마우스가 머문 링크를 분석합니다.
  background.js에 메시지를 보내고, 결과가 오면 팝업을 업데이트합니다.

  매개변수:
    link    - 분석할 <a> 요소
    event   - 마우스 이벤트 (팝업 위치 계산용)
    options - { forceRefresh: true } 이면 캐시를 무시하고 재분석

  동작 흐름:
    ① 로딩 팝업을 띄움
    ② background.js에 ANALYZE_NEWS_LINK 메시지 전송 (분석 요청)
    ③ background.js가 분석을 완료하면 콜백으로 결과 수신
    ④ 결과에 따라 팝업을 성공/오류 화면으로 전환
*/
function analyzeHoveredLink(link, event, options = {}) {
  const href = link.href;

  if (!href || !/^https?:\/\//i.test(href)) {
    return;
  }

  // 요청 ID를 1 올림. 이 값을 나중에 응답이 왔을 때와 비교해서
  // 이미 다른 링크로 이동했으면 이전 응답을 무시할 수 있음
  const requestId = ++currentRequestId;

  // 링크 안의 텍스트를 추출하고 공백을 정리한 뒤 최대 300자로 자름
  // innerText: 렌더링된 텍스트 (줄바꿈, 숨겨진 요소 반영)
  // textContent: 렌더링과 무관한 원시 텍스트 (fallback으로 사용)
  const linkText = normalizeText(link.innerText || link.textContent || "").slice(0, MAX_LINK_TEXT_LENGTH);

  // 뉴스 기사 여부를 먼저 조용히 확인한 뒤, 뉴스로 판별되어 본 분석에 들어갈 때 로딩 팝업을 표시
  analysisStartedForActiveLink = true;
  popupOpenPoint = { x: event.clientX, y: event.clientY };
  sendStatus("hover_confirmed", "1초 머무름 확인", href);

  /*
    chrome.runtime.sendMessage: background.js에 분석 요청 메시지를 보냅니다.
    첫 번째 인수: 보낼 메시지 객체
    두 번째 인수: background.js가 sendResponse()를 호출하면 이 콜백이 실행됨

    메시지 구조:
      type    - "ANALYZE_NEWS_LINK" (background.js의 메시지 분류에 사용)
      payload - 분석에 필요한 데이터
        url           - 분석할 링크 주소
        link_text     - 링크 텍스트
        force_refresh - 캐시 무시 여부
  */
  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_NEWS_LINK",
      payload: {
        url:           href,
        link_text:     linkText,
        force_refresh: Boolean(options.forceRefresh),
        skip_article_check: Boolean(options.skipArticleCheck)
      }
    },
    (response) => {
      // 응답이 왔을 때 이미 다른 링크로 이동했거나 마우스가 벗어났으면 무시
      // requestId가 currentRequestId와 다르면 이 응답은 오래된 것임
      if (requestId !== currentRequestId || activeLink !== link) {
        return;
      }

      // chrome.runtime.lastError: 메시지 전송 자체가 실패했을 때 세팅됨
      // 예) background.js가 아직 실행되지 않았거나, 확장 프로그램이 업데이트된 경우
      if (chrome.runtime.lastError) {
        showErrorPopup("확장 프로그램과 통신하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
        return;
      }

      // background.js가 { ok: false, error: "..." } 로 응답한 경우
      if (!response || !response.ok) {
        showErrorPopup(response?.error || "AI 분석 중 문제가 발생했습니다.");
        return;
      }

      if (!response.data?.is_article) {
        hidePopup();
        return;
      }

      // 성공! response.data에 분석 결과 객체가 담겨 있음
      showResultPopup(response.data);
    }
  );
}


// ─────────────────────────────────────────────
// background.js에 현재 상태를 알리는 함수
// ─────────────────────────────────────────────

/*
  sendStatus: content.js가 현재 어느 단계인지를 background.js에 알립니다.
  background.js는 이 정보를 저장소에 기록하고, action_popup.js가 읽어서 단계 표시를 업데이트합니다.

  매개변수:
    stage - 단계 식별자 (예: "link_detected", "idle")
    label - 화면에 보여줄 텍스트 (예: "링크 인식")
    url   - 현재 분석 중인 URL
*/
function sendStatus(stage, label, url) {
  chrome.runtime.sendMessage({
    type:    "STATUS_UPDATE",
    payload: { stage, label, url }
  });
}

/*
  normalizeText: 문자열 안의 연속된 공백, 줄바꿈 등을 하나의 공백으로 정리하고
  앞뒤 공백도 제거합니다.
  링크 텍스트에 줄바꿈이나 탭 문자가 섞여 있을 때 깔끔하게 만들기 위해 사용합니다.
*/
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isStatusForActiveLink(status) {
  return activeLink && normalizeUrlForCompare(status.url) === normalizeUrlForCompare(activeLink.href);
}

function normalizeUrlForCompare(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function isPopupInteractionGraceActive() {
  return Date.now() < suppressPopupMouseOutUntil;
}

function schedulePopupCloseAfterGrace() {
  window.clearTimeout(popupGraceCloseTimer);
  popupGraceCloseTimer = window.setTimeout(() => {
    if (isPointerInsideActiveAreas()) {
      return;
    }
    closePopupFromPointerExit();
  }, Math.max(0, suppressPopupMouseOutUntil - Date.now()) + 20);
}

function isPointerInsideActiveAreas() {
  if (!lastMouseEvent) {
    return false;
  }

  const element = document.elementFromPoint(lastMouseEvent.clientX, lastMouseEvent.clientY);
  return Boolean(element && (popup?.contains(element) || activeLink?.contains(element)));
}

function closePopupFromPointerExit() {
  const shouldSendIdle = analysisStartedForActiveLink;
  clearHoverTimer();
  activeLink = null;
  analysisStartedForActiveLink = false;
  popupOpenPoint = null;
  currentRequestId += 1;
  hidePopup();
  if (shouldSendIdle) {
    sendStatus("idle", "대기 중", "");
  }
}

function getPopupOpenPoint() {
  return popupOpenPoint || popupAnchor;
}

function showLoadingPopupAtAnchor(message) {
  const point = getPopupOpenPoint();
  if (point) {
    showLoadingPopup(point.x, point.y, message);
  }
}


// ─────────────────────────────────────────────
// 팝업 DOM 요소 관리
// ─────────────────────────────────────────────

/*
  ensurePopup: 팝업 div 요소를 반환합니다.
  처음 호출될 때 한 번만 요소를 생성하고 페이지에 추가합니다.
  이후 호출에서는 이미 만든 요소를 재사용합니다.
  이렇게 하면 DOM에 같은 요소가 중복으로 생기는 것을 방지합니다.

  생성된 팝업은 id="ai-news-link-popup"을 가지며,
  popup.css가 이 id를 기준으로 스타일을 적용합니다.
*/
function ensurePopup() {
  if (popup) {
    return popup; // 이미 만들었으면 바로 반환
  }

  popup = document.createElement("div");
  popup.id = "ai-news-link-popup";
  popup.hidden = true; // 처음엔 숨김 상태로 생성

  // 팝업 내부 클릭 이벤트 (버튼 동작 처리)
  popup.addEventListener("click", handlePopupClick);
  // 팝업에서 마우스가 나가면 팝업 닫기
  popup.addEventListener("mouseout", handlePopupMouseOut);

  // <html> 태그 바로 아래에 추가 (body가 아닌 이유: z-index 충돌 방지)
  document.documentElement.appendChild(popup);
  return popup;
}

/*
  handlePopupClick: 팝업 안의 버튼을 클릭했을 때 실행됩니다.
  어떤 버튼인지는 data-ai-news-action 속성 값으로 구분합니다.
  HTML에서 이렇게 사용합니다: <button data-ai-news-action="toggle-details">상세 정보 보기</button>

  버튼 동작:
    "toggle-details" → 세부 항목 펼치기/접기
*/
function handlePopupClick(event) {
  // event.target에서 가장 가까운 data-ai-news-action 속성을 가진 요소를 찾음
  // .dataset.aiNewsAction → data-ai-news-action 속성 값 (케밥→카멜 변환 자동)
  const button = event.target.closest("[data-ai-news-action]");
  const action = button?.dataset.aiNewsAction;

  if (action === "toggle-details") {
    toggleDetails(button);
  }
}

/*
  toggleDetails: <details> 태그의 열림/닫힘 상태를 반전시킵니다.
  <details open> 이면 세부 항목이 펼쳐진 상태, open이 없으면 접힌 상태입니다.
  내용이 바뀌면 팝업 높이가 달라지므로 keepPopupInViewport()도 호출합니다.
*/
function toggleDetails(button) {
  const details = popup?.querySelector(".ai-news-popup__details");
  if (details) {
    suppressPopupMouseOutUntil = Date.now() + POPUP_INTERACTION_GRACE_MS;
    details.open = !details.open; // true면 false로, false면 true로 반전
    if (button) {
      button.textContent = details.open ? "간략히 보기" : "상세 정보 보기";
    }
    keepPopupInViewport();
  }
}

/*
  handlePopupMouseOut: 팝업 밖으로 마우스가 나갔을 때 실행됩니다.
  팝업 안이나 원래 링크로 돌아가는 경우는 무시하고,
  완전히 다른 곳으로 나가면 팝업을 닫습니다.
*/
function handlePopupMouseOut(event) {
  if (isPopupInteractionGraceActive()) {
    schedulePopupCloseAfterGrace();
    return;
  }

  // 팝업 내부나 원래 링크로 이동한 경우 무시
  if (popup?.contains(event.relatedTarget) || activeLink?.contains(event.relatedTarget)) {
    return;
  }

  closePopupFromPointerExit();
}


// ─────────────────────────────────────────────
// 팝업 화면 상태 전환 함수들
// ─────────────────────────────────────────────

/*
  showLoadingPopup: 분석이 시작되면 로딩 중 팝업을 표시합니다.
  로딩 애니메이션(링)과 진행 중 메시지를 보여줍니다.
  background.js가 STATUS_BROADCAST를 보낼 때마다 updateLoadingStatus()가
  메시지 텍스트를 실시간으로 바꿔줍니다.

  innerHTML에 HTML 문자열을 직접 넣어서 내용을 한 번에 교체합니다.
  `백틱 문자열`은 ${변수}를 사용할 수 있는 템플릿 리터럴입니다.
  사용자 데이터는 반드시 escapeHtml()을 거쳐서 XSS 공격을 방지합니다.
  (XSS: 악의적인 HTML/JS 코드가 주입되는 보안 취약점)
*/
function showLoadingPopup(x, y, message = "AI 분석 중...") {
  const popupElement = ensurePopup();
  popupElement.className = "ai-news-popup ai-news-popup--loading";
  popupElement.innerHTML = `
    <section class="news-ai-card">
      ${renderBrandHeader()}
      <div class="news-ai-loading">
        <div class="news-ai-loading__ring"></div>
        <div>
          <p class="news-ai-loading__title">${escapeHtml(message)}</p>
          <p class="news-ai-loading__text">링크 인식, 뉴스 판별, 기사 분석 순서로 진행합니다.</p>
        </div>
      </div>
    </section>
  `;
  popupElement.hidden = false;
  positionPopup(x, y);
}

/*
  updateLoadingStatus: 로딩 팝업이 열려 있는 동안 진행 상황 텍스트만 교체합니다.
  innerHTML 전체를 다시 쓰지 않고 텍스트 노드만 바꿔서 효율적입니다.
  background.js에서 STATUS_BROADCAST 메시지가 올 때마다 호출됩니다.
*/
function updateLoadingStatus(message) {
  const status = popup?.querySelector(".news-ai-loading__title");
  // 현재 로딩 상태일 때만 텍스트 변경 (결과가 표시되고 있을 때 덮어쓰지 않도록)
  if (status && popup.classList.contains("ai-news-popup--loading")) {
    status.textContent = message;
  }
}

/*
  showErrorPopup: 분석 중 오류가 발생하면 오류 메시지 팝업을 표시합니다.
*/
function showErrorPopup(message) {
  const popupElement = ensurePopup();
  popupElement.className = "ai-news-popup ai-news-popup--error";
  popupElement.innerHTML = `
    <section class="news-ai-card">
      ${renderBrandHeader()}
      <div class="news-ai-error">
        <p class="news-ai-error__title">분석할 수 없습니다</p>
        <p class="news-ai-error__text">${escapeHtml(message)}</p>
      </div>
    </section>
  `;
  popupElement.hidden = false;

  const point = getPopupOpenPoint();
  if (point) {
    positionPopup(point.x, point.y);
  }
}

/*
  showResultPopup: background.js로부터 분석 결과를 받아서 팝업을 완성합니다.
  result.is_article에 따라 두 가지 화면을 보여줍니다:
    - false: "뉴스 기사 아님" 간략 화면
    - true:  신뢰도·어그로도 점수 + 세부 항목 전체 화면

  화면 구성:
    - 브랜드 헤더 (로고 + inton)
    - 신뢰도 점수 카드 + 어그로도 점수 카드
    - 기사 한 줄 요약
    - 분석 요약 목록
    - 세부 항목 (접기/펼치기 가능)
    - 버튼 (세부 보기, 다시 분석)
*/
function showResultPopup(result) {
  const popupElement = ensurePopup();

  // 뉴스 기사가 아닌 경우
  if (!result.is_article) {
    popupElement.className = "ai-news-popup";
    popupElement.innerHTML = `
      <section class="news-ai-card">
        ${renderBrandHeader("뉴스 기사 아님")}
        <div class="news-ai-summary">
          ${renderSummaryLines(result.summary || "이 링크는 뉴스 기사로 보기 어렵습니다.", result.warning || "뉴스 기사 링크에서 다시 시도하세요.")}
        </div>
        ${renderActions(false)}
      </section>
    `;
    popupElement.hidden = false;
    const point = getPopupOpenPoint();
    if (point) positionPopup(point.x, point.y);
    return;
  }

  // 점수를 0~100 범위의 정수로 보정
  const credibilityScore = toScore(result.credibility_score);
  const clickbaitScore   = toScore(result.clickbait_score);
  // 점수에 따른 등급 (예: 80 이상 → "높은 신뢰", className: "good")
  const credibilityLevel = getCredibilityLevel(credibilityScore);
  const clickbaitLevel   = getClickbaitLevel(clickbaitScore);

  popupElement.className = "ai-news-popup";
  popupElement.innerHTML = `
    <section class="news-ai-card">
      ${renderBrandHeader("분석 완료")}
      <div class="news-ai-score-grid">
        <div class="news-ai-score-card news-ai-score-card--${credibilityLevel.className}">
          <p class="news-ai-kicker">신뢰도</p>
          <strong>${credibilityScore}<span>/100</span></strong>
          <small>${credibilityLevel.label}</small>
        </div>
        <div class="news-ai-score-card news-ai-score-card--clickbait">
          <p class="news-ai-kicker">제목 어그로 지수</p>
          <strong>${clickbaitScore}<span>/100</span></strong>
          <small>${clickbaitLevel.label}</small>
        </div>
      </div>
      <div class="news-ai-article-summary">
        <p class="news-ai-kicker">기사 한 줄 요약</p>
        <strong>${escapeHtml(result.article_summary || "기사 요약을 생성하지 못했습니다.")}</strong>
      </div>
      <div class="news-ai-summary">
        ${renderSummaryLines(result.summary || "요약 정보가 없습니다.", result.warning || "AI 분석은 참고용입니다.")}
      </div>
      <details class="news-ai-details ai-news-popup__details">
        <summary>세부 항목</summary>
        ${renderBreakdown("신뢰도", result.credibility_breakdown, [
          ["source_clarity",  "출처 명확성",    20],
          ["title_body_match","제목/본문 일치도", 25],
          ["evidence_quality","근거 충실도",     25],
          ["neutrality",      "표현 중립성",     15],
          ["context",         "맥락 제공성",     15]
        ])}
        ${renderBreakdown("어그로도", result.clickbait_breakdown, [
          ["exaggeration",       "과장 표현",      20],
          ["curiosity_gap",      "궁금증 유도",    20],
          ["title_body_mismatch","제목/본문 불일치",25],
          ["emotional_trigger",  "감정 자극",      20],
          ["hidden_key_info",    "핵심 정보 은폐", 15]
        ])}
      </details>
      ${renderActions(true)}
    </section>
  `;
  popupElement.hidden = false;

  const point = getPopupOpenPoint();
  if (point) {
    positionPopup(point.x, point.y);
  }
}


// ─────────────────────────────────────────────
// HTML 조각(부품)을 만드는 렌더링 함수들
// ─────────────────────────────────────────────

/*
  renderBrandHeader: 팝업 상단의 로고 + 이름 + 상태 텍스트 영역 HTML을 반환합니다.
  chrome.runtime.getURL()은 확장 프로그램 패키지 내부 파일의 전체 URL을 반환합니다.
  예) "chrome-extension://확장ID/assets/icon48.png"
  이 URL은 manifest.json의 web_accessible_resources에 등록된 파일만 사용 가능합니다.
*/
function renderBrandHeader(statusText = "AI 기반 기사 신뢰도 분석") {
  const logoUrl = chrome.runtime.getURL("assets/icon48.png");
  return `
    <header class="news-ai-header">
      <div class="news-ai-logo" aria-hidden="true">
        <img src="${escapeHtml(logoUrl)}" alt="">
      </div>
      <div>
        <h1>inton</h1>
        <p>${escapeHtml(statusText)}</p>
      </div>
    </header>
  `;
}

/*
  renderSummaryLines: AI가 반환한 요약(summary)과 경고(warning) 텍스트를
  "." 또는 줄바꿈 기준으로 쪼개 최대 3개 항목의 목록으로 만들어 반환합니다.
  너무 긴 텍스트를 깔끔하게 여러 줄로 분리해서 보여주기 위한 함수입니다.
*/
function renderSummaryLines(summary, warning) {
  const lines = [summary, warning]
    .flatMap((text) => String(text).split(/[.\n]/)) // "."과 줄바꿈으로 쪼갬
    .map((text) => text.trim())
    .filter(Boolean)   // 빈 문자열 제거
    .slice(0, 3);      // 최대 3개만 사용

  return `
    <div class="news-ai-summary__title">분석 요약</div>
    <ul>
      ${lines.map((line) => `<li>${escapeHtml(line)}.</li>`).join("")}
    </ul>
  `;
}

/*
  renderActions: 팝업 하단의 버튼 영역 HTML을 반환합니다.
  hasDetails가 false이면 "상세 분석 보기" 버튼을 비활성화(disabled)합니다.
  (뉴스 기사가 아닐 때는 세부 항목이 없으므로 비활성화)
*/
function renderActions(hasDetails) {
  return `
    <div class="news-ai-actions">
      <button class="news-ai-button news-ai-button--primary" type="button" data-ai-news-action="toggle-details" ${hasDetails ? "" : "disabled"}>상세 정보 보기</button>
    </div>
  `;
}

/*
  renderBreakdown: 신뢰도 또는 어그로도의 세부 항목 점수 목록 HTML을 반환합니다.

  매개변수:
    title     - 섹션 제목 ("신뢰도" 또는 "어그로도")
    breakdown - AI가 반환한 세부 점수 객체 { source_clarity: 15, ... }
    rows      - 표시할 항목 정보 배열. 각 항목은 [키, 표시명, 최대점수] 형태
                예) ["source_clarity", "출처 명확성", 20]

  각 항목을 "출처 명확성 — 15/20" 형태로 나열합니다.
*/
function renderBreakdown(title, breakdown = {}, rows) {
  const items = rows
    .map(([key, label, max]) => {
      // breakdown 객체에서 해당 키의 값을 숫자로 변환. 유효하지 않으면 0
      const value = Number.isFinite(Number(breakdown[key])) ? Number(breakdown[key]) : 0;
      return `
        <div class="news-ai-breakdown__row">
          <span>${escapeHtml(label)}</span>
          <b>${value}/${max}</b>
        </div>
      `;
    })
    .join(""); // 배열을 하나의 문자열로 합침

  return `
    <div class="news-ai-breakdown">
      <h3>${escapeHtml(title)}</h3>
      ${items}
    </div>
  `;
}


// ─────────────────────────────────────────────
// 팝업 위치를 계산하고 화면 안에 유지하는 함수들
// ─────────────────────────────────────────────

/*
  positionPopup: 팝업을 마우스 커서 근처에 표시합니다.
  단순히 커서 오른쪽 아래에만 놓으면 화면 오른쪽/아래 가장자리에서 잘릴 수 있습니다.
  그래서 커서를 기준으로 4방향(우하/우상/좌하/좌상) 후보를 모두 계산하고,
  화면 밖으로 가장 적게 나가는 위치를 선택합니다.

  positionPopup은 아래 세 곳에서 호출됩니다:
    - showLoadingPopup: 로딩 팝업 처음 표시할 때
    - showErrorPopup / showResultPopup: 내용 업데이트 후
    - keepPopupInViewport: 스크롤/리사이즈 시 재계산
*/
function positionPopup(clientX, clientY) {
  const popupElement   = ensurePopup();
  const margin         = 10;  // 커서와 팝업 사이의 여백 (픽셀)
  const viewportPadding = 10; // 화면 가장자리와 팝업 사이의 최소 여백
  popupAnchor = { x: clientX, y: clientY }; // 나중에 재계산할 때 사용하도록 저장

  // 팝업이 화면보다 커지지 않도록 최대 크기 설정
  popupElement.style.maxWidth  = `${Math.max(220, window.innerWidth  - viewportPadding * 2)}px`;
  popupElement.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;

  // 현재 팝업의 실제 크기 측정 (위에서 maxWidth/maxHeight를 설정했으므로 반영됨)
  const rect   = popupElement.getBoundingClientRect();
  const width  = Math.min(rect.width,  window.innerWidth  - viewportPadding * 2);
  const height = Math.min(rect.height, window.innerHeight - viewportPadding * 2);

  // 커서를 기준으로 4가지 배치 후보 좌표 계산
  const candidates = [
    { name: "right-bottom", left: clientX + margin,         top: clientY + margin          },
    { name: "right-top",    left: clientX + margin,         top: clientY - height - margin },
    { name: "left-bottom",  left: clientX - width - margin, top: clientY + margin          },
    { name: "left-top",     left: clientX - width - margin, top: clientY - height - margin }
  ];

  // 각 후보가 화면 밖으로 얼마나 나가는지(overflow) 계산해서 가장 적은 것 선택
  const best = candidates
    .map((candidate) => {
      // 네 방향 각각의 넘침량을 더해서 총 overflow 계산
      const overflow =
        Math.max(0, viewportPadding - candidate.left) +                                   // 왼쪽으로 넘침
        Math.max(0, viewportPadding - candidate.top) +                                    // 위쪽으로 넘침
        Math.max(0, candidate.left + width  - (window.innerWidth  - viewportPadding)) +   // 오른쪽으로 넘침
        Math.max(0, candidate.top  + height - (window.innerHeight - viewportPadding));    // 아래쪽으로 넘침

      // 기존 객체에 overflow 속성만 추가한 새 객체 반환
      // ... (스프레드 연산자): 객체를 복사하면서 추가 속성 붙이기
      return { ...candidate, overflow };
    })
    .sort((a, b) => a.overflow - b.overflow)[0]; // overflow 오름차순 정렬 후 첫 번째 (가장 작은) 선택

  // 최종 좌표를 화면 경계 안으로 한 번 더 보정
  const left = Math.min(
    Math.max(viewportPadding, best.left),
    Math.max(viewportPadding, window.innerWidth  - width  - viewportPadding)
  );
  const top = Math.min(
    Math.max(viewportPadding, best.top),
    Math.max(viewportPadding, window.innerHeight - height - viewportPadding)
  );

  // data-placement 속성 설정 (CSS에서 방향에 따른 세밀한 스타일 조정에 사용 가능)
  popupElement.dataset.placement = best.name;
  popupElement.style.left = `${left}px`;
  popupElement.style.top  = `${top}px`;
}

/*
  keepPopupInViewport: 창 크기가 바뀌거나 스크롤됐을 때
  팝업 위치를 다시 계산해서 화면 안에 유지합니다.
  requestAnimationFrame: 다음 화면 렌더링 직전에 실행해서
  레이아웃 재계산과 화면 그리기가 한 번에 이루어지도록 최적화합니다.
*/
function keepPopupInViewport() {
  if (!popup || popup.hidden || !popupAnchor) {
    return; // 팝업이 없거나 숨겨진 상태면 아무것도 안 함
  }

  window.requestAnimationFrame(() => {
    if (popup && !popup.hidden && popupAnchor) {
      positionPopup(popupAnchor.x, popupAnchor.y);
    }
  });
}

/*
  hidePopup: 팝업을 화면에서 숨깁니다.
  hidden = true 로 설정하면 display: none과 유사하게 보이지 않게 되고,
  스크린 리더 같은 접근성 도구도 이 요소를 무시합니다.
*/
function hidePopup() {
  if (popup) {
    popup.hidden = true;
  }
  popupAnchor = null; // 위치 기준점도 초기화
  popupOpenPoint = null;
}


// ─────────────────────────────────────────────
// 점수를 등급으로 변환하는 함수들
// ─────────────────────────────────────────────

/*
  getCredibilityLevel: 신뢰도 점수를 받아 등급 정보 객체를 반환합니다.
  80점 이상: 높은 신뢰 (녹색)
  50~79점: 검토 필요 (노란색)
  49점 이하: 낮은 신뢰 (빨간색)

  반환 객체:
    label     - 화면에 표시할 텍스트
    className - CSS 클래스 이름 (색상 스타일 적용용)
    color     - 직접 색상 코드 (그래프 등에 사용 가능)
*/
function getCredibilityLevel(score) {
  const normalized = toScore(score);
  if (normalized >= 80) return { label: "높은 신뢰", className: "good",    color: "#22c55e" };
  if (normalized >= 50) return { label: "검토 필요", className: "caution", color: "#f59e0b" };
  return                        { label: "낮은 신뢰", className: "bad",     color: "#ef4444" };
}

/*
  getClickbaitLevel: 어그로도 점수를 받아 등급 정보 객체를 반환합니다.
  어그로도는 낮을수록 좋습니다:
  20점 이하: 낮음 (좋음)
  21~40점: 약간 있음
  41~60점: 주의
  61점 이상: 높음 (나쁨)
*/
function getClickbaitLevel(score) {
  const normalized = toScore(score);
  if (normalized <= 20) return { label: "낮음",      className: "good" };
  if (normalized <= 40) return { label: "약간 있음", className: "normal" };
  if (normalized <= 60) return { label: "주의",      className: "caution" };
  return                        { label: "높음",      className: "bad" };
}

/*
  toScore: 어떤 값이든 0~100 사이의 정수로 변환합니다.
  숫자가 아닌 값은 0으로 처리합니다.
  소수점은 반올림으로 제거합니다.
*/
function toScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/*
  escapeHtml: 문자열 안의 HTML 특수 문자를 안전한 코드로 변환합니다.
  AI 응답이나 기사 제목 등 외부 데이터를 innerHTML에 넣기 전에 반드시 거칩니다.
  이 처리 없이 바로 innerHTML에 넣으면 XSS(악성 스크립트 삽입) 취약점이 생깁니다.

  변환 대상:
    &  → &amp;   (앰퍼샌드)
    <  → &lt;    (여는 꺾쇠 → 태그로 해석되지 않도록)
    >  → &gt;    (닫는 꺾쇠)
    "  → &quot;  (큰따옴표 → 속성 값 탈출용)
    '  → &#039;  (작은따옴표)
*/
function escapeHtml(value) {
  return String(value)
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#039;");
}
