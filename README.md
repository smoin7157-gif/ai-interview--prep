# 🎯 InterviewIQ — AI Interview Prep & Feedback Platform

A **mock interview co-pilot** that runs fully on your machine. Upload your resume + a job description, and the platform builds a personalized interview around your role and target company, quizzes you with an adaptive AI interviewer, ML-scores every answer, and produces a post-interview report that tracks your improvement across sessions.

Built from the spec in `ai prep document.txt`:

> User uploads resume + target job description → RAG pulls relevant interview questions → live mock interview (LLM asks questions, adapts follow-ups) → ML component scores answers on structural criteria → post-interview report with improvement tracking.

---

## ✨ Features

| # | Feature | How it works |
|---|---------|--------------|
| 1 | **Resume + JD upload** | Drag-drop a `.pdf` / `.docx` / `.txt` resume (extracted locally), paste a job description. Role, skills, and target company are **auto-detected**. |
| 2 | **RAG question bank** | A curated knowledge base (78 questions, 15 topics, 6 company patterns) is retrieved by a sparse-vector retriever — cosine similarity over word + character n-gram embeddings, boosted by topic overlap and company-pattern matches. |
| 3 | **Adaptive live interview** | A LangGraph-style state machine: LLM asks questions, fires targeted **follow-ups** on weak answers, tracks topic coverage, and **adjusts difficulty** based on your scores. |
| 4 | **ML answer scoring** | A lightweight **logistic-regression classifier** (trained at startup on a rubric dataset) scores STAR structure, action verbs, filler words, relevance, clarity, and quantified evidence — independent of LLM judgment. Blended with an optional LLM judge when a key is set. |
| 5 | **Post-interview report** | Score gauge, criteria radar, strengths/gaps, recommended resources, question-by-question breakdown, and an **improvement sparkline** across your session history. |

Plus: 🎤 **voice answers** via the browser's Web Speech API (Chrome/Edge), 🔒 100% local persistence in SQLite (`node:sqlite`, zero native deps), and an **offline rule-based engine** so the app works even without an API key.

---

## 🚀 Run locally

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install        # install deps (express, multer, pdf-parse, mammoth, dotenv)
npm start          # -> http://localhost:3000
```

Open **http://localhost:3000**, hit **New Interview**, paste a job description (optionally drop a resume), and go.

### Enable the LLM engine (recommended)

The app runs offline out of the box, but the LLM powers tailored opening questions, adaptive follow-ups, answer judgment, and richer reports.

1. Get a key at **https://openrouter.ai/keys**
2. Copy `.env.example` → `.env` (already created for you) and paste:
   ```
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o-mini   # any OpenRouter model
   ```
3. Restart: `npm start`

Free model option: `meta-llama/llama-3.3-70b-instruct:free`

---

## 🏗️ Architecture

```
public/                     Zero-build SPA (vanilla JS + CSS, no CDNs)
  index.html                app shell + hash router
  styles.css                dark glassmorphism design system
  app.js                    views: home · setup · interview · report · history
server/
  index.js                  Express entry, static serving, error handling
  routes.js                 REST API + resume extraction (multer/pdf-parse/mammoth)
  config.js                 env config (.env)
  db.js                     SQLite persistence (node:sqlite) — sessions + turns
  rag.js                    RAG retriever: profile inference + ranked retrieval
  embed.js                  sparse lexical embeddings (words + char trigrams)
  interview.js              adaptive state machine (difficulty, coverage, follow-ups)
  ml.js                     feature extraction + logistic-regression classifier
  llm.js                    OpenRouter client + graceful offline fallback
data/
  knowledge-base.json       curated question bank + role/topic/company taxonomies
  sessions.db               local SQLite database (gitignored)
tests/
  smoke.js                  end-to-end API smoke test
```

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server + KB + LLM status |
| GET | `/api/meta/roles` | Available roles & companies |
| POST | `/api/resume/extract` | Upload resume → extracted text |
| POST | `/api/sessions` | Create session (JD + resume + options) → opening question |
| GET | `/api/sessions` | Session history |
| GET | `/api/sessions/:id` | Full record (turns + report) |
| POST | `/api/sessions/:id/answer` | Submit answer → score + next question/follow-up |
| POST | `/api/sessions/:id/complete` | Finish → generate + persist report |

### How the interview state machine works

```
start → (tailored opening) → answer → ML score (+LLM judge) → weak? → follow-up
                                                              ↘ strong? → next question
        difficulty: score ≥72 → +1, ≤42 → −1 (clamped 1–3)
        next question: uncovered topics first, ranked by retrieval × difficulty fit
        after N questions → closing → report (strengths/gaps/resources + improvement)
```

### The ML scoring model

Each answer is reduced to 7 features: `[length, STAR coverage, action-verb ratio, question relevance, filler penalty, quantified evidence, clarity]`. A binary logistic-regression classifier — trained at startup on a deterministic synthetic rubric dataset — maps these to a probability of "strong answer", which is blended with the per-criterion composite. `ml.trainFromLabeledRows()` is exported so real human-labeled answers can replace the synthetic data later without touching the pipeline.

---

## ☁️ Deploy to Vercel

The repo is Vercel-ready — `api/index.js` + `vercel.json` route all traffic through the Express app (serverless adapter).

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project → Import** the GitHub repo.
3. Framework preset: **Other** (no build command — `vercel.json` handles it).
4. In **Settings → Environment Variables** add `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL`).
5. Deploy.

> ⚠️ **Persistence:** Vercel's serverless filesystem is read-only, so the app falls back to an **in-memory database** there — sessions won't survive cold starts. For persistent sessions on Vercel, wire a hosted store (Vercel Postgres / KV / Upstash) into `server/db.js`.

## 🧪 Testing

```bash
npm run check     # syntax-check all server modules
# with the server running:
node tests/smoke.js   # full API flow: session → answers → follow-ups → report → history
```

## 🗺️ Roadmap

- [ ] Neural embeddings (`@huggingface/transformers`) swap-in for the RAG retriever
- [ ] Real human-labeled answer dataset to retrain the ML classifier
- [ ] Voice output (text-to-speech) for the interviewer
- [ ] Curated question bank expansion + community contributions
- [ ] Webhooks to fold the report into HireAI's mock-interview feature
