# TaskPilot

TaskPilot uses browser speech recognition for live voice transcription where supported, then sends recognized text or typed instructions to the Google Gemini Developer API to extract task fields as structured JSON. If browser speech recognition is unavailable, the app sends the audio to Gemini for transcription. The app does not save audio and sends input only after the user checks the data-use consent box. On Google's free tier, submitted content may be used to improve Google products. Review Google's [Gemini API pricing and data-use terms](https://ai.google.dev/gemini-api/docs/pricing) before using real or sensitive data.

## Set up the Gemini API

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` to your own key. Do not paste the key into chat, frontend code, or a `VITE_` variable. `.env` is ignored by Git.
3. The default is `gemini-3.5-flash-lite`, a low-latency model that supports structured output. If `.env` already sets `GEMINI_MODEL`, change it to `gemini-3.5-flash-lite` and restart the server to use the faster model.
4. Run `npm install`, then `npm run dev`. The web UI and local API server start together. The API server restarts automatically when `server.mjs` changes; restart `npm run dev` after changing `.env`.

If the key is not configured, the server returns a clear setup error; it never falls back silently to the local parser. Gemini requests can take up to 60 seconds, and API errors include a safe, shortened explanation from Google when available, without exposing the API key. The API server also enforces request-size limits, a per-IP rate limit, and schema validation. Free-tier model access and quotas can change and are controlled by Google.

If the page says it received a web page instead of an API response, stop any older `npm run dev` processes and restart `npm run dev`. The web app uses port 5173 and the API uses port 3001; startup now fails clearly if the web port is already occupied instead of silently choosing a different port.

## Production

Run `npm run build`, then set the server environment variables (`GEMINI_API_KEY`, and optionally `PORT` and `HOST`) and run `npm run start`. The Node server serves the built frontend and the `/api/understand` endpoint from the same origin. On a hosting platform that requires a public bind address, set `HOST=0.0.0.0`.

## Voice workflow

1. Open the task composer and check the Google Gemini data-use consent.
2. Choose the input language and press the microphone button. Where supported, browser speech recognition shows a live transcript and automatically processes it after a short pause; you can also press stop. The text is sent to Gemini for task understanding. If live recognition is unavailable, the recording is sent to Gemini for transcription and interpretation (recordings are limited to 45 seconds).
3. Review the transcript and populated task form. A complete, unambiguous task is added to the session task list after Gemini verifies the fields. If information is missing or unclear, answer the clarification or edit the fields and click **Create task**. Browser speech-recognition services may process microphone audio under their own terms; this app does not save audio.
4. For typed input, enter an instruction and press **Process instructions**. You can describe a new task or ask Gemini to update form options naturally (for example, “I want this to recur every week”) without saying “create a task.”
5. Resolve any clarification or edit the fields. Complete, verified instructions are added automatically; use **Create task** to submit an edited draft manually.

The Gemini API key remains on the server. Microphone access is requested only when recording starts. You can use typed commands instead of recording.
