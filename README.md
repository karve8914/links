# 文章網址連線檢查（GitHub 版）

這是一個可放在 GitHub 管理、再由 Vercel 直接從 GitHub 部署的網頁工具。

## 功能

- 可一次上傳多個 PDF 或 Word（`.docx`）
- 支援拖曳檔案
- PDF：讀取頁面文字與 PDF 內建超連結
- DOCX：讀取文件本文、頁首頁尾、註腳、尾註、註解與實際超連結
- 自動清除網址末尾常見標點
- 自動合併重複網址
- 檢查結果只顯示：`可連線` / `無法連線`
- 可匯出 CSV
- 可一鍵複製所有「無法連線」網址
- PDF / DOCX 檔案本身不會上傳到後端；文件在瀏覽器內解析，後端只收到網址

## 判定原則

這個工具是用於編務快速檢查，因此採「寬鬆」二分判定：

- HTTP 2xx：可連線
- HTTP 3xx：跟隨重新導向後判定
- HTTP 401 / 403 / 429：視為「可連線」；代表網站仍存在，但限制登入或自動程式存取
- HTTP 404 / 410、其他 4xx、5xx：無法連線
- DNS、TLS、逾時或其他網路錯誤：無法連線

畫面不會顯示 HTTP 狀態碼或錯誤種類。

## Word 格式

支援新版 Word `.docx`。

舊式 `.doc` 不支援瀏覽器直接解析，請先用 Word「另存新檔」為 `.docx`。

## PDF 限制

如果 PDF 是掃描影像，且沒有 OCR 文字層，就無法從頁面文字擷取網址。不過如果 PDF 本身另有設定可點擊的 URL annotation，仍可能抓得到。

## 上傳到 GitHub

1. 在 GitHub 建立一個新的 repository，例如 `url-checker`。
2. 把此專案所有檔案上傳到 repository 根目錄。
3. 確認 GitHub Actions 的 `Build check` 顯示綠色勾勾即可。

專案已包含 `.github/workflows/build.yml`，每次 push 都會自動測試能否正常建置。

## 從 GitHub 部署到 Vercel

GitHub Pages 本身只有靜態網頁，無法可靠地從瀏覽器直接檢查任意外部網址，因此仍需要一個極小的後端。此專案已包含 `/api/check.js`，最簡單的方式是用 Vercel：

1. 登入 Vercel。
2. 選 `Add New` → `Project`。
3. Import 你剛建立的 GitHub repository。
4. Framework Preset 可讓 Vercel 自動判定 Vite；若需要手動設定：
   - Build Command：`npm run build`
   - Output Directory：`dist`
5. 按 `Deploy`。
6. 完成後 Vercel 會提供一個 HTTPS 網址，公司同仁只要打開該網址即可使用。

之後只要更新 GitHub repository，Vercel 會自動重新部署。

## 本機開發

需要 Node.js 20 以上版本：

```bash
npm install
npm run dev
```

前端本機開發時，`/api/check` 仍需 Vercel dev 或已部署的後端才會真正運作。

## 隱私與安全

- PDF / DOCX 不會傳到伺服器。
- 文件解析全部在使用者瀏覽器執行。
- 後端只收到文件中擷取出的網址。
- API 會拒絕 localhost、私有 IP 與內網 IP，避免被用來存取伺服器內部資源。
