# Git 編輯器

在瀏覽器裡讀取 `.git`，用樹狀圖看 commit 歷史，修改 commit 的訊息、作者、時間，還能用私鑰簽名。純前端，檔案不會上傳到任何伺服器。

👉 https://mason276752.github.io/giteditor/

## 功能

- **開啟**：拖入 repo 資料夾或裡面的 `.git` 資料夾，或按「開啟 repo 資料夾」選擇；bare repo 也可以。SHA-1 與 SHA-256 的 repo 都支援
- **看歷史**：所有分支、標籤、遠端分支畫成樹狀的 commit 圖（新的在上、parent 一定在 child 下面，和 `git log --graph --date-order --all` 一樣）。可以搜尋訊息、作者、hash（Enter 下一個、Shift+Enter 上一個），`↑`／`↓` 切換 commit。幾萬個 commit 也只要不到一秒
- **看內容**：每個 commit 的檔案樹，點檔案預覽文字、圖片或十六進位內容，也能看 commit 的原始物件。另外可以直接瀏覽 `.git` 資料夾：loose 物件會先解壓縮，pack 索引、packfile、暫存區（index）也會解讀
- **修改 commit**：訊息、作者、提交者，以及作者時間與提交者時間（到秒，含時區）。提交者預設跟著作者一起改。舊編碼（Big5、GBK…）的 commit 改過之後改存成 UTF-8
- **後面的 commit 跟著改寫**：改一個 commit，它之後的 commit（parent 變了）會一起重算 hash，內容、作者、時間都不變。本地分支移到新的 commit；標籤（輕量標籤或附註標籤）可以選擇一起移；遠端分支不動，因為它代表遠端現在的樣子
- **簽名（可選）**：用 SSH 或 GPG 私鑰簽名，和 `git commit -S` 的格式相同，`git verify-commit` 驗得過。後面跟著改寫的 commit 可以選擇移除失效的簽名、原本有簽名的重新簽，或全部簽名；附註標籤原本有簽名的也一樣處理
- **寫回去**：Chrome、Edge 可以直接寫回 `.git`：寫入新的物件、移動分支，並留下 reflog 和 `ORIG_HEAD`，隨時能用 `git reflog` 退回。寫入前會確認分支沒有在別處被改過（例如在終端機又 commit 了），有的話就不寫
- **bundle**：Firefox、Safari 不能寫入資料夾，就下載一個只含新 commit 的 git bundle，再用 `git bundle unbundle` 和 `git update-ref` 套用（頁面會給出完整指令）。`update-ref` 帶著舊的值，分支在這之間被改過就會拒絕
- **復原**：寫入前的每一次修改都能復原、重做（`⌘Z`、`⌘⇧Z`），或一次全部放棄

改 commit 就是改寫歷史，commit 的 hash 都會變。已經推上遠端的分支要用 `git push --force-with-lease` 才能更新；寫入後頁面會列出要執行的指令。

### 簽名

| 金鑰 | 支援 |
| --- | --- |
| SSH：`-----BEGIN OPENSSH PRIVATE KEY-----` | ed25519、RSA（簽成 `rsa-sha2-512`）、ECDSA P-256／P-384／P-521；有密碼的私鑰（bcrypt + AES-CTR／AES-GCM）也可以 |
| SSH：PEM 格式 | 沒有密碼的 PKCS#1（`BEGIN RSA PRIVATE KEY`）與 PKCS#8（`BEGIN PRIVATE KEY`） |
| GPG：`-----BEGIN PGP PRIVATE KEY BLOCK-----` | 用 [OpenPGP.js](https://openpgpjs.org/)，有密碼的私鑰也可以 |

SSH 簽名的格式和 `ssh-keygen -Y sign -n git` 一樣，要驗證的話 git 需要設定 `gpg.format=ssh` 與 `gpg.ssh.allowedSignersFile`；GitHub 要把公鑰加成「Signing key」才會顯示 Verified。私鑰只在分頁的記憶體裡用來簽名，不會上傳、也不會存起來，簽章運算交給瀏覽器的 WebCrypto。

不支援：硬體金鑰（`sk-ssh-ed25519@openssh.com` 等 FIDO 金鑰，私鑰在裝置裡）、X.509（gpgsm）、有密碼的舊式 PEM 私鑰（可以先用 `ssh-keygen -p -f 金鑰檔` 改存成新格式）。這裡不驗證既有的簽名，只標出有沒有、是哪一種。

### 限制

- 只改 commit 本身（訊息、作者、時間、簽名），不改檔案內容
- 用 reftable 格式存分支的 repo（`extensions.refStorage=reftable`）還不支援
- worktree 與 submodule 的 `.git` 是指向別處的檔案，請改開它指的那個資料夾
- 淺層複製（shallow clone）沒有的舊 commit、部分複製（partial clone）沒下載的檔案，會標成讀不到
- Firefox、Safari 開啟的資料夾是當下的快照；執行 bundle 的指令之後，要重新開啟才看得到新的狀態

## 怎麼做到的

全部在瀏覽器裡用 TypeScript 完成，不需要 git：

- 讀取：loose 物件用 zlib 解壓縮；packfile 依 `.idx` 找到位置，解開 `OFS_DELTA`／`REF_DELTA` 差異壓縮。分支讀 `refs/` 與 `packed-refs`。大的 packfile 只分段讀需要的部分
- 改寫：重組 commit 物件時，沒改到的欄位保留原本的位元組，所以沒改的 commit hash 不會變；用 WebCrypto 重算 SHA-1／SHA-256
- 寫回：Chrome、Edge 用 [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API) 的目錄控制代碼寫入 `.git`；bundle 是自己組的 packfile（v2，SHA-256 的 repo 用 v3）

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/giteditor/
npm test           # 用真的 git 驗證讀取、改寫、寫回、bundle、SSH／GPG 簽名（需要 git 與 ssh-keygen）
npm run build      # 型別檢查 + 輸出到 dist/
```

推到 `main` 後，GitHub Actions 會建置並發布到 `gh-pages` 分支。

## 授權

使用 [Vue](https://vuejs.org/)（MIT）、[fflate](https://github.com/101arrowz/fflate)（MIT）解壓縮與壓縮 zlib，以及 [bcrypt-pbkdf](https://github.com/joyent/node-bcrypt-pbkdf)（BSD-3-Clause，內含 [TweetNaCl.js](https://tweetnacl.js.org/)，公有領域）解開有密碼的 SSH 私鑰，只在遇到時載入。

GPG 簽名用 [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)（LGPL-3.0-or-later）：未修改，打包成獨立的檔案，只在載入 GPG 私鑰時才下載；授權全文隨網站發布在 `openpgp.LICENSE`。
