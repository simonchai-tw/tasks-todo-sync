# Google Gemini Saved Info (Personalization) for Tasks–To Do Sync

> This configuration guide sets up Google Gemini (Gemini mobile app, Android "Hey Google", and web) to automatically append the required `[TTS-TIME:HH:mm]` marker in Google Tasks notes whenever a time-specific task is requested.

---

## Precondition Check

Before saving the personalization prompt, verify that your Google account has the **Google Workspace** extension enabled in Gemini and that it correctly preserves multiline notes when creating tasks:

1. Send this test instruction to Gemini:
   > *"Add a task to Google Tasks titled Test Task, with notes line 1 AAA, and on a new line BBB."*
2. Open **Google Tasks** (mobile app or web) and inspect the created task:
   - Verify that the **Details** field contains `AAA` and `BBB` separated by a newline.
   - If multiline details are preserved, proceed with the configuration below.

---

## Production Personalization Prompt

Copy the complete text block below and save it directly into Gemini's **Saved Info** (Memory / Personalization settings):

```text
Whenever I ask you to create a Google Tasks task or reminder, in any language, a background script parses the task's Details (notes) field, so always fill Details through the task tool, even when you also set a native due time.

If I mention a clock time (for example 3:30 pm, half past seven tonight, noon, or in half an hour), the very first line of Details must be exactly [TTS-TIME:HH:mm] in 24-hour, zero-padded, half-width characters, and this marker must appear nowhere else. So 7:40 pm becomes [TTS-TIME:19:40] and 9:05 am becomes [TTS-TIME:09:05]. Never write 00:00; use 00:01 instead. If I also gave notes, put them after the marker with one blank line between. Set the due date to the calendar date the time resolves to; relative times count from now and roll past midnight into the next day. Keep the title to the task itself, without the time.

If I give no clock time (a date only, or vague words like morning or evening), Details contains only my notes or stays empty. Never add a marker, placeholder, or guessed time. For example, remind me to buy eggs tomorrow leaves Details empty.
```

> [!TIP]
> **Do not use "Optimize / Rewrite"**: Save the prompt exactly as provided. AI rewriters frequently strip the strict `[TTS-TIME:HH:mm]` syntax. If accidentally rewritten, verify that the exact bracketed marker format is intact.

---

## Configuration Steps

### Option A: Via Gemini Settings (Recommended)
1. Open the **Gemini App** (Android / iOS) or visit **[gemini.google.com](https://gemini.google.com)**.
2. Tap your **Profile Picture** in the top right corner.
3. Select **Settings** → **Saved Info** (or *Personalization / Things to remember*).
4. Paste the prompt block above into the text field.
5. Save directly without applying AI rewrites.

### Option B: Via Chat Command
Send this message directly to Gemini in any active conversation:
> *"Remember this preference: [Paste the prompt block above]"*

Gemini will confirm: *"I've saved this preference to your info."*

---

## Verification Test Cases

After saving your preferences, test Gemini with the following 5 conversational requests to verify output compliance in Google Tasks:

| Scenario | Voice / Text Prompt | Expected Result in Google Tasks |
| :--- | :--- | :--- |
| **1. Afternoon Time** | *"Remind me to pay bills tomorrow at 3:30 pm"* | Line 1: `[TTS-TIME:15:30]`, Title: *Pay bills* |
| **2. Single-Digit Hour** | *"Meeting at 9:05 am tomorrow"* | Line 1: `[TTS-TIME:09:05]` (zero-padded) |
| **3. Midnight Boundary** | *"Remind me in 30 minutes"* (tested at 23:35) | Due date rolls over to next day; time formatted as `[TTS-TIME:00:05]` |
| **4. Date-Only Without Clock Time** | *"Remind me to buy eggs tomorrow"* | Details completely empty (no marker or guessed time) |
| **5. Time with Additional Notes** | *"Dinner at 7:30 pm on Friday, bring receipt"* | Line 1: `[TTS-TIME:19:30]`<br>Line 2: *(blank line)*<br>Line 3: *bring receipt* |

---

## Operational Notes & Lifecycle

1. **Extension Requirement**: Ensure the **Google Workspace** extension is toggled on in Gemini Settings (**Settings → Extensions → Google Workspace**).
2. **Automated Splicing**: The `[TTS-TIME:HH:mm]` marker in Google Tasks notes is temporary. During the next synchronization cycle (0–10 minutes), Tasks–To Do Sync parses the time, sets the Microsoft To Do reminder, projects the Google Calendar event, and **automatically splices the marker line and trailing blank line**, leaving completely clean notes.
3. **Fail-Closed Grammar**: The prompt aligns strictly with Time Bridge Spec v2.4 (24-hour uppercase formatting, strict bounds `00:01`–`23:59`, and whole-notes uniqueness checks).
