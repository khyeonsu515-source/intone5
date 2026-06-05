/*
  =====================================================================
  options.js
  =====================================================================

  이 파일은 확장 프로그램의 설정 페이지(options.html)에서 실행됩니다.
  사용자가 Groq API 키를 입력하고 저장하거나 삭제하는 기능을 담당합니다.

  이 파일이 하는 일:
  1. 설정 페이지가 열리면 이미 저장된 API 키가 있는지 확인해서 입력칸에 표시합니다.
  2. 저장 버튼을 누르면 입력된 키를 브라우저 저장소에 저장합니다.
  3. 삭제 버튼을 누르면 저장된 키를 삭제합니다.

  ★ 다른 파일과의 관계
     - options.html이 이 파일을 불러옵니다.
     - 여기서 저장한 API 키를 background.js의 getGroqApiKey()가 읽어서 사용합니다.
     - manifest.json의 "options_page": "options.html" 설정 덕분에
       확장 프로그램 관리 페이지에서 "옵션" 버튼을 누르면 이 페이지가 열립니다.

  =====================================================================
*/


// ─────────────────────────────────────────────
// DOM 요소 참조 변수 선언
// ─────────────────────────────────────────────

/*
  DOM 요소들은 HTML이 완전히 로드된 후에만 찾을 수 있으므로
  일단 선언만 해두고, DOMContentLoaded 이벤트 안에서 실제 값을 넣습니다.
  const 대신 let을 쓴 이유가 바로 이 때문입니다.
*/
let form;          // <form id="options-form"> — API 키 입력 폼 전체
let apiKeyInput;   // <input id="api-key"> — API 키를 직접 입력하는 텍스트 박스
let cerebrasApiKeyInput;
let clearButton;   // <button id="clear-key"> — "삭제" 버튼
let statusElement; // <p id="status"> — "저장되었습니다" 등 결과 메시지를 보여주는 단락


// ─────────────────────────────────────────────
// DOM이 완전히 로드된 후 초기화
// ─────────────────────────────────────────────

/*
  DOMContentLoaded: 브라우저가 options.html의 HTML 파싱을 끝낸 직후 발생합니다.
  이 시점 이후에야 getElementById로 요소를 찾을 수 있습니다.
  이 이벤트 안에서 요소를 찾고 이벤트를 연결하는 것이 안전한 순서입니다.
*/
document.addEventListener("DOMContentLoaded", () => {
  // 각 HTML 요소를 ID로 찾아서 변수에 저장
  form          = document.getElementById("options-form");
  apiKeyInput   = document.getElementById("api-key");
  cerebrasApiKeyInput = document.getElementById("cerebras-api-key");
  clearButton   = document.getElementById("clear-key");
  statusElement = document.getElementById("status");

  /*
    이벤트 리스너 연결:
    form.addEventListener("submit", 함수): 폼 안의 "저장" 버튼을 누르거나
    Enter 키를 치면 발생하는 submit 이벤트에 saveApiKey 함수를 연결합니다.

    clearButton.addEventListener("click", 함수): "삭제" 버튼 클릭 시 clearApiKey 실행.
    이 버튼은 type="button"이라서 폼 submit을 발생시키지 않습니다.
  */
  form.addEventListener("submit", saveApiKey);
  clearButton.addEventListener("click", clearApiKey);

  // 페이지가 열리자마자 이미 저장된 키가 있으면 입력칸에 채워줌
  loadSavedKey();
});


// ─────────────────────────────────────────────
// 저장된 API 키를 읽어 입력칸에 표시하는 함수
// ─────────────────────────────────────────────

/*
  loadSavedKey: 브라우저 저장소에서 "groqApiKey" 키로 저장된 값을 읽어서
  입력 칸에 미리 채워줍니다. 사용자가 설정 페이지를 열 때마다 키를 다시 입력하지 않아도 됩니다.

  chrome.storage.local.get(키 배열, 콜백):
    저장소에서 지정한 키들의 값을 읽고, 읽기가 끝나면 콜백 함수를 호출합니다.
    콜백의 매개변수 items는 { groqApiKey: "저장된값" } 형태의 객체입니다.
    해당 키가 없으면 items.groqApiKey는 undefined가 됩니다.
*/
function loadSavedKey() {
  chrome.storage.local.get(["groqApiKey", "groqApiKeys", "cerebrasApiKeys"], (items) => {
    // typeof items.groqApiKey === "string": 값이 실제 문자열인지 확인
    // items.groqApiKey가 빈 문자열("")인 경우는 표시할 필요가 없으므로 &&로 추가 확인
    const keys = Array.isArray(items.groqApiKeys)
      ? items.groqApiKeys.filter((key) => typeof key === "string" && key.trim())
      : [];
    const legacyKey = typeof items.groqApiKey === "string" && items.groqApiKey.trim()
      ? [items.groqApiKey.trim()]
      : [];
    const savedKeys = keys.length ? keys : legacyKey;

    if (savedKeys.length) {
      apiKeyInput.value = savedKeys.join("\n"); // 입력칸에 저장된 키 값 채우기
    }

    const cerebrasKeys = Array.isArray(items.cerebrasApiKeys)
      ? items.cerebrasApiKeys.filter((key) => typeof key === "string" && key.trim())
      : [];
    if (cerebrasKeys.length) {
      cerebrasApiKeyInput.value = cerebrasKeys.join("\n");
    }

    if (savedKeys.length || cerebrasKeys.length) {
      setStatus(`저장된 API Key가 Groq ${savedKeys.length}개, Cerebras ${cerebrasKeys.length}개 있습니다.`);
    }
  });
}


// ─────────────────────────────────────────────
// API 키를 저장하는 함수 (폼 제출 이벤트 핸들러)
// ─────────────────────────────────────────────

/*
  saveApiKey: "저장" 버튼을 눌렀을 때 호출됩니다.
  event 매개변수는 폼 제출 이벤트 객체입니다.

  event.preventDefault():
    폼의 기본 동작(페이지 새로고침 또는 다른 페이지로 이동)을 막습니다.
    이 한 줄이 없으면 "저장" 버튼을 눌렀을 때 페이지가 새로고침되어
    입력한 내용이 사라지고 저장 확인도 볼 수 없게 됩니다.
*/
function saveApiKey(event) {
  event.preventDefault(); // 폼의 기본 페이지 이동/새로고침 동작 차단

  // .trim(): 실수로 앞뒤에 공백을 넣었을 때 자동으로 제거
  const apiKeys = parseApiKeys(apiKeyInput.value);
  const cerebrasApiKeys = parseApiKeys(cerebrasApiKeyInput.value);

  // 빈 값이면 저장하지 않고 오류 메시지 표시
  if (!apiKeys.length && !cerebrasApiKeys.length) {
    setStatus("API Key를 1개 이상 입력하세요.", true); // true = 오류 상황 (빨간색 표시)
    return; // 여기서 함수 종료, 아래 저장 코드 실행 안 함
  }

  /*
    chrome.storage.local.set({ 키: 값 }, 콜백):
    저장소에 데이터를 저장합니다. 저장이 완료되면 콜백이 호출됩니다.
    여기서 저장한 값을 background.js의 getGroqApiKey()가 나중에 읽어서 사용합니다.
  */
  chrome.storage.local.set({
    groqApiKeys: apiKeys,
    groqApiKey: apiKeys[0] || "",
    cerebrasApiKeys,
    groqActiveKeyIndex: 0,
    aiActiveCredentialIndex: 0
  }, () => {
    apiKeyInput.value = apiKeys.join("\n");
    cerebrasApiKeyInput.value = cerebrasApiKeys.join("\n");
    setStatus(`API Key를 Groq ${apiKeys.length}개, Cerebras ${cerebrasApiKeys.length}개 저장했습니다.`); // 저장 완료 메시지
  });
}


// ─────────────────────────────────────────────
// API 키를 삭제하는 함수 ("삭제" 버튼 클릭 핸들러)
// ─────────────────────────────────────────────

/*
  clearApiKey: "삭제" 버튼을 눌렀을 때 호출됩니다.
  저장소에서 API 키를 지우고 입력칸도 비웁니다.

  chrome.storage.local.remove(키 배열, 콜백):
    저장소에서 지정한 키들을 삭제합니다.
    삭제가 완료되면 콜백이 호출됩니다.
*/
function clearApiKey() {
  chrome.storage.local.remove(["groqApiKey", "groqApiKeys", "cerebrasApiKeys", "groqActiveKeyIndex", "aiActiveCredentialIndex"], () => {
    apiKeyInput.value = ""; // 입력칸 비우기
    cerebrasApiKeyInput.value = "";
    setStatus("API Key를 삭제했습니다.");
  });
}

function parseApiKeys(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean)
    .filter((key) => {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}


// ─────────────────────────────────────────────
// 상태 메시지를 표시하는 공통 함수
// ─────────────────────────────────────────────

/*
  setStatus: 폼 아래의 상태 메시지 영역에 텍스트를 표시합니다.
  오류일 때와 성공일 때 텍스트 색상을 다르게 합니다.

  매개변수:
    message - 표시할 메시지 문자열
    isError - 오류 상황이면 true, 성공/정상이면 false (기본값)
              true면 빨간색, false면 초록색으로 표시
*/
function setStatus(message, isError = false) {
  statusElement.textContent = message;
  // 삼항 연산자: 조건 ? 참일 때 값 : 거짓일 때 값
  statusElement.style.color = isError ? "#a43131" : "#12633d";
}
