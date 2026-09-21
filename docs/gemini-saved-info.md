# Google Gemini Saved Info (Personalization) for Tasks-ToDo-Sync

> This prompt configures Google Gemini (Gemini App, Android "Hey Google", and Web) to automatically generate the required `[TTS-TIME:HH:mm]` marker in Google Tasks notes whenever a time-specific task is requested.

---

## 🔍 Precondition Check (手動驗證 Gemini Tasks 工具)

在套用個性化提示詞前，請先確認您的 Gemini 是否具備寫入 Google Tasks 備忘（Details / notes）與保留換行的能力：

1. 對 Gemini 輸入測試指令：
   > 「幫我在 Google Tasks 建立一個任務：測試任務，備忘寫第一行AAA，換行寫第二行BBB」
2. 開啟 **Google Tasks App** 或網頁版，點開該任務：
   - 檢查「詳細資料（Details）」是否成功包含 `AAA` 與 `BBB`，且換行保持完整。
   - 若確認可正常寫入備忘與換行，即可安心設定下方的 Saved Info。

---

## 📋 Recommended Production Prompt (Copy & Paste)

複製下方方框內的**完整文字**，貼入 Gemini 的 **Saved Info**（已儲存的資訊 / 記憶與個人化）：

```text
Whenever I ask you to create a Google Tasks task or reminder, in any language, a background script parses the task's Details (notes) field, so always fill Details through the task tool, even when you also set a native due time.

If I mention a clock time (for example 3:30 pm, half past seven tonight, noon, or in half an hour), the very first line of Details must be exactly [TTS-TIME:HH:mm] in 24-hour, zero-padded, half-width characters, and this marker must appear nowhere else. So 7:40 pm becomes [TTS-TIME:19:40] and 9:05 am becomes [TTS-TIME:09:05]. Never write 00:00; use 00:01 instead. If I also gave notes, put them after the marker with one blank line between. Set the due date to the calendar date the time resolves to; relative times count from now and roll past midnight into the next day. Keep the title to the task itself, without the time.

If I give no clock time (a date only, or vague words like morning or evening), Details contains only my notes or stays empty. Never add a marker, placeholder, or guessed time. For example, remind me to buy eggs tomorrow leaves Details empty.
```

> [!TIP]
> **切勿點擊「✨ 最佳化 / 魔法棒」重寫**：儲存後請直接保留原樣。魔法棒改寫容易將 `[TTS-TIME:HH:mm]` 當成雜訊抹除。若不慎按到，請務必回讀確認中括號與字串代碼依然完整。

---

## 📱 How to Configure in Gemini

### Method 1: Via Gemini Settings (Recommended)
1. Open the **Gemini App** (Android / iOS) or visit **[gemini.google.com](https://gemini.google.com)**.
2. Tap your **Profile Picture** in the top right corner.
3. Go to **Settings** → **Saved Info** (已儲存的資訊 / 記憶設定).
4. Paste the prompt block above into the **Things to remember** field.
5. Save directly without using AI rewrite.

### Method 2: Direct Conversational Command
Send this message directly to Gemini in any active chat:
> *"Remember this preference: [Paste the prompt block above]"*

Gemini will confirm: *"I've saved this preference to your info."*

---

## 🧪 5-Case Acceptance Verification (驗收測試)

設定完成後，建議對 Gemini 發出以下 5 句語音或文字指令驗收輸出：

| 測試情境 | 測試指令 | 預期結果（Google Tasks 檢視） |
| :--- | :--- | :--- |
| **1. 下午時間** | 「明天下午 3 點半提醒我繳費」 | 第一行 Details：`[TTS-TIME:15:30]`，標題為「繳費」 |
| **2. 個位數小時零補位** | 「早上 9 點 5 分開會」 | 第一行 Details：`[TTS-TIME:09:05]`（不可漏補 0） |
| **3. 午夜邊界防禦** | 「半小時後提醒我」（於 23:35 測試） | 日期跨至隔天，時間非 `00:00`（如 `[TTS-TIME:00:05]`） |
| **4. 模糊詞純日期** | 「明天早上買蛋」 | Details **完全為空**（不設 marker、不猜測時間） |
| **5. 時間 + 附帶備忘** | 「後天晚上七點半，附註帶發票」 | Line 1: `[TTS-TIME:19:30]`<br>Line 2: *(空行)*<br>Line 3: `帶發票` |

---

## ⚠️ Notes & Operational Invariants
1. **Tool Requirement**: 確保 Gemini 已開啟 **Google Tasks 擴充功能**（`設定` → `擴充功能` → `Google Workspace`）。
2. **Marker Lifecycle**: Details 中的 `[TTS-TIME:HH:mm]` 標記僅為暫存。Tasks-ToDo-Sync 在下個週期（0–10 分鐘內）同步時，會設定 Microsoft To Do 鬧鐘與 Google 日曆事件，並**自動切除該標記行與相連的空行**，維持乾淨的備忘。
3. **Spec Alignment**: 本提示詞與 Time Bridge Spec v2.4 雙向互鎖（包含拒絕 `00:00`、Fail-Closed Regex `([01]\d|2[0-3])`、Whole-Notes check 防重複標記）。
