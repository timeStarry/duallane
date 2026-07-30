const NETWORK_ERROR_MESSAGE = "网络连接失败，请检查连接后重试。";
const TIMEOUT_ERROR_MESSAGE = "请求超时，请稍后重试。";

export function userFacingErrorMessage(error: unknown, fallback: string) {
  if (isAbortError(error)) {
    return TIMEOUT_ERROR_MESSAGE;
  }

  if (isNetworkError(error)) {
    return NETWORK_ERROR_MESSAGE;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isNetworkError(error: unknown) {
  if (error instanceof TypeError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /failed to fetch|fetch failed|network\s*error|load failed|internet connection appears to be offline/i.test(error.message);
}
