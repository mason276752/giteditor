# Git 編輯器

在瀏覽器裡讀取 `.git`，用樹狀圖看 commit 歷史，用表單或 git 指令修改 commit 的訊息、作者、時間和檔案內容，還能用私鑰簽名。純前端，檔案不會上傳到任何伺服器。

👉 https://mason276752.github.io/giteditor/

## 功能

- **開啟**：拖入 repo 資料夾或裡面的 `.git` 資料夾，或按「開啟 repo 資料夾」選擇；bare repo 也可以。SHA-1 與 SHA-256 的 repo 都支援
- **看歷史**：所有分支、標籤、遠端分支畫成樹狀的 commit 圖（新的在上、parent 一定在 child 下面，和 `git log --graph --date-order --all` 一樣）。可以搜尋訊息、作者、hash（Enter 下一個、Shift+Enter 上一個），`↑`／`↓` 切換 commit。幾萬個 commit 也只要不到一秒
- **切換**：工具列的選單或 commit 面板的「切換到這裡」可以切到任何分支、標籤、遠端分支或 commit。這是頁面裡的 checkout：不會改 repo 的 HEAD、暫存區或你資料夾裡的檔案
- **Dangling commit**：勾選樹狀圖上方的「dangling」，會找出沒有任何分支、標籤、HEAD 指著的 commit（例如 amend、rebase、reset 之前的版本），畫在圖上（虛線標籤），可以打開看檔案樹、切過去，或建分支救回來。`git fsck` 也會列出來
- **看內容**：每個 commit 的檔案樹，點檔案預覽文字、圖片或十六進位內容，也能看 commit 的原始物件。另外可以直接瀏覽 `.git` 資料夾：loose 物件會先解壓縮，pack 索引、packfile、暫存區（index）也會解讀
- **修改 commit**：訊息、作者、提交者，以及作者時間與提交者時間（到秒，含時區）。提交者預設跟著作者一起改。舊編碼（Big5、GBK…）的 commit 改過之後改存成 UTF-8
- **改檔案內容**：在 commit 面板的檔案樹按鉛筆改任何一個 commit 裡的文字檔。後面的 commit 會用三方合併帶入同樣的修改（和 rebase 一樣）；有後面的 commit 改到同一段（或相鄰的行）就整個取消，什麼都不改。會保留 UTF-8 BOM 和 CRLF 換行
- **後面的 commit 跟著改寫**：改一個 commit，它之後的 commit（parent 變了）會一起重算 hash，內容、作者、時間都不變。本地分支移到新的 commit；標籤（輕量標籤或附註標籤）可以選擇一起移；遠端分支不動，因為它代表遠端現在的樣子
- **簽名（可選）**：用 SSH 或 GPG 私鑰簽名，和 `git commit -S` 的格式相同，`git verify-commit` 驗得過。後面跟著改寫的 commit 可以選擇移除失效的簽名、原本有簽名的重新簽，或全部簽名；附註標籤原本有簽名的也一樣處理
- **寫回去**：Chrome、Edge 可以直接寫回 `.git`：寫入新的物件、移動分支，並留下 reflog 和 `ORIG_HEAD`，隨時能用 `git reflog` 退回。寫入前會確認分支沒有在別處被改過（例如在終端機又 commit 了），有的話就不寫
- **bundle**：Firefox、Safari 不能寫入資料夾，就下載一個只含新 commit 的 git bundle，再用 `git bundle unbundle` 和 `git update-ref` 套用（頁面會給出完整指令）。`update-ref` 帶著舊的值，分支在這之間被改過就會拒絕
- **復原**：寫入前的每一次修改都能復原、重做（`⌘Z`、`⌘⇧Z`），或一次全部放棄

改 commit 就是改寫歷史，commit 的 hash 都會變。已經推上遠端的分支要用 `git push --force-with-lease` 才能更新；寫入後頁面會列出要執行的指令。

### 終端機

按工具列的「終端機」（或 Ctrl+\`）打開。指令作用在頁面裡的虛擬工作區：它從目前 checkout 的 commit 開始，改的是頁面記住的狀態，每個指令都能復原，按「寫入 .git」或下載 bundle 才會進 repo。一個指令失敗時，它做到一半的修改會整個退回。

| 指令 | 說明 |
| --- | --- |
| `git status`、`log`、`show`、`diff` | `log --oneline`、`--format=…`、`--date=iso`、`--all`、`a..b`；`show <rev>:<path>`；`diff --staged`、`--stat`、`--name-status` |
| `git switch`、`checkout` | 切換分支，`-c` 建分支，`--detach` 切到任何 commit；遠端分支同名時自動建本地分支 |
| `git add`、`rm`、`mv`、`restore`、`reset` | 暫存區與 `reset --soft／--mixed／--hard` |
| `git commit` | `-m`、`-a`、`--amend`、`--no-edit`、`--author`、`--date`、`-S`；`GIT_AUTHOR_DATE`、`GIT_COMMITTER_DATE` 等環境變數。沒有 `-m` 時開編輯器 |
| `git rebase` | `<upstream>`、`--onto`、`--root`、`-i`（pick、reword、edit、squash、fixup、drop、break，可以調整順序）、`--continue`、`--abort`、`--committer-date-is-author-date`、`--ignore-date`、`-S` |
| `git cherry-pick`、`revert`、`merge` | 三方合併；merge 可以 fast-forward 或 `--no-ff`。遇到衝突就取消（這裡沒有手動解衝突） |
| `git branch`、`tag` | 列出、建立、刪除（`-d`、`-D`）、改名（`-m`）；`tag -a`、`tag -s` |
| `git fsck`、`reflog`、`rev-parse`、`cat-file`、`ls-tree`、`ls-files`、`show-ref`、`config` | 其他 |
| `ls`、`cat`、`edit`（`vim`、`nano`、`code`）、`echo … > 檔案`、`echo … >> 檔案`、`touch`、`rm`、`mv` | 改工作區的檔案；`edit` 開編輯器 |

可以用 `&&`、`||`、`;` 串接，Tab 補完指令、分支和檔名，↑／↓ 叫出之前的指令。輸出盡量和 git 一樣（`log`、`ls-tree`、`cat-file` 等測試裡直接和 git 比對）。改舊 commit 的檔案，可以 `git rebase -i` 把那一行改成 `edit`，停下來後改檔案、`git commit --amend`、`git rebase --continue`；或在 commit 面板直接改。

不支援：`push`、`pull`、`fetch`（頁面不連網路）、`stash`、手動解決衝突、`rebase --rebase-merges`（rebase 和 git 預設一樣會略過 merge commit）。

### 簽名

| 金鑰 | 支援 |
| --- | --- |
| SSH：`-----BEGIN OPENSSH PRIVATE KEY-----` | ed25519、RSA（簽成 `rsa-sha2-512`）、ECDSA P-256／P-384／P-521；有密碼的私鑰（bcrypt + AES-CTR／AES-GCM）也可以 |
| SSH：PEM 格式 | 沒有密碼的 PKCS#1（`BEGIN RSA PRIVATE KEY`）與 PKCS#8（`BEGIN PRIVATE KEY`） |
| GPG：`-----BEGIN PGP PRIVATE KEY BLOCK-----` | 用 [OpenPGP.js](https://openpgpjs.org/)，有密碼的私鑰也可以 |

SSH 簽名的格式和 `ssh-keygen -Y sign -n git` 一樣，要驗證的話 git 需要設定 `gpg.format=ssh` 與 `gpg.ssh.allowedSignersFile`；GitHub 要把公鑰加成「Signing key」才會顯示 Verified。私鑰只在分頁的記憶體裡用來簽名，不會上傳、也不會存起來，簽章運算交給瀏覽器的 WebCrypto。

不支援：硬體金鑰（`sk-ssh-ed25519@openssh.com` 等 FIDO 金鑰，私鑰在裝置裡）、X.509（gpgsm）、有密碼的舊式 PEM 私鑰（可以先用 `ssh-keygen -p -f 金鑰檔` 改存成新格式）。這裡不驗證既有的簽名，只標出有沒有、是哪一種。

### 限制

- 頁面裡的 checkout 和工作區是虛擬的，不會改你資料夾裡的檔案。改到 repo 目前 checkout 的 commit 的檔案時，寫入後頁面會給一行 `git restore …`，在電腦上執行就能讓工作目錄跟上
- 不能刪除或改名 repo 目前 checkout 的分支（磁碟上的 HEAD）
- 用 reftable 格式存分支的 repo（`extensions.refStorage=reftable`）還不支援
- worktree 與 submodule 的 `.git` 是指向別處的檔案，請改開它指的那個資料夾
- 淺層複製（shallow clone）沒有的舊 commit、部分複製（partial clone）沒下載的檔案，會標成讀不到
- Firefox、Safari 開啟的資料夾是當下的快照；執行 bundle 的指令之後，要重新開啟才看得到新的狀態

## 怎麼做到的

全部在瀏覽器裡用 TypeScript 完成，不需要 git：

- 讀取：loose 物件用 zlib 解壓縮；packfile 依 `.idx` 找到位置，解開 `OFS_DELTA`／`REF_DELTA` 差異壓縮。分支讀 `refs/` 與 `packed-refs`。大的 packfile 只分段讀需要的部分
- 改寫：重組 commit 物件時，沒改到的欄位保留原本的位元組，所以沒改的 commit hash 不會變；用 WebCrypto 重算 SHA-1／SHA-256
- 合併：tree 一層一層比，兩邊相同的子目錄直接沿用不讀；文字檔用 Myers 差異演算法做三方合併（diff3）
- 找 dangling commit：從 pack 索引和每個物件的標頭讀出型別（不解壓縮內容），再扣掉從所有分支、標籤、HEAD 走得到的 commit
- 寫回：Chrome、Edge 用 [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API) 的目錄控制代碼寫入 `.git`；bundle 是自己組的 packfile（v2，SHA-256 的 repo 用 v3）

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/giteditor/
npm test           # 用真的 git 驗證讀取、改寫、寫回、bundle、終端機指令、SSH／GPG 簽名（需要 git 與 ssh-keygen）
npm run build      # 型別檢查 + 輸出到 dist/
```

推到 `main` 後，GitHub Actions 會建置並發布到 `gh-pages` 分支。

## 授權

使用 [Vue](https://vuejs.org/)（MIT）、[fflate](https://github.com/101arrowz/fflate)（MIT）解壓縮與壓縮 zlib，以及 [bcrypt-pbkdf](https://github.com/joyent/node-bcrypt-pbkdf)（BSD-3-Clause，內含 [TweetNaCl.js](https://tweetnacl.js.org/)，公有領域）解開有密碼的 SSH 私鑰，只在遇到時載入。

GPG 簽名用 [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)（LGPL-3.0-or-later）：未修改，打包成獨立的檔案，只在載入 GPG 私鑰時才下載；授權全文隨網站發布在 `openpgp.LICENSE`。
