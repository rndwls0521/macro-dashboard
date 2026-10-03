// 앱 화면 파일은 캐시 우선(오프라인 실행), 데이터(data/*.json)는 네트워크 우선 + 실패 시 캐시.
// 앱 파일을 바꾸면 VERSION을 올린다.
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = "data";
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.includes("/data/")) {
    const key = url.origin + url.pathname; // 쿼리(?t=) 무시하고 저장
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(key).then((r) => r || Response.error())),
    );
    return;
  }

  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
