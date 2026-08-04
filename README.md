# 🎯 InterviewIQ — AI Interview Prep & Feedback Platform

A **mock interview co-pilot** that runs fully on your machine. Upload your resume + a job description, and the platform builds a personalized interview around your role and target company, quizzes you with an adaptive AI interviewer, ML-scores every answer, and produces a post-interview report that tracks your improvement across sessions.

> 🔗 **Live on Vercel:** https://ai-interview-prep-nwpr.vercel.app

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
| 6 | **Teacher & student workspaces** | Two role-based layouts behind a **full login system** (username/password): students get the interview co-pilot flow, teachers get a warm-toned console to **manage the question bank** and **assign interviews** to any student. |
| 7 | **Teacher-assigned interviews** | Teachers create focused mock interviews (role + company + question count) for students; they appear instantly in the student's **My interviews** and their scores are visible back in the teacher's console. |

Plus: 🎤 **voice answers** via the browser's Web Speech API (Chrome/Edge), 🔒 100% local persistence in SQLite (`node:sqlite`, zero native deps), and an **offline rule-based engine** so the app works even without an API key.

---

## 🌐 Live deployment

This repo is deployed on Vercel:

- **Production:** https://ai-interview-prep-nwpr.vercel.app
- GitHub: https://github.com/smoin7157-gif/ai-interview--prep

> ℹ️ To enable the **LLM engine on the hosted app**, add `OPENROUTER_API_KEY` in **Vercel → Project → Settings → Environment Variables** and redeploy. Until then the hosted app runs on the offline rule-based engine (`llm: false`).

## 🚀 Run locally

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install        # install deps (express, multer, pdf-parse, mammoth, dotenv)
npm start          # -> http://localhost:3000
```

Open **http://localhost:3000**, create an account (**student** or **teacher**), and pick your flow:

- **Student** → *New Interview*: paste a job description (optionally drop a resume), or take an interview your teacher assigned under *My interviews*.
- **Teacher** → *Question bank* to curate the questions, and *Assign interview* to hand a focused mock interview to any student.

> 🔒 Passwords are hashed with `crypto.scrypt` and sessions use HttpOnly cookies — no extra dependencies.

### Enable the LLM engine (recommended)

The app runs offline out of the box, but the LLM powers tailored opening questions, adaptive follow-ups, answer judgment, and richer reports.

1. Get a key at **https://openrouter.ai/keys**
2. Copy `.env.example` → `.env` (already created for you) and paste:
   ```
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-oss-20b:free   # free model (default); any OpenRouter model works
   ```
3. Restart: `npm start`

> Free model option (default): `openai/gpt-oss-20b:free` — run `curl https://openrouter.ai/api/v1/models` (with your key) to list currently available `:free` models.

---

## 🏗️ Architecture

```
public/                     Zero-build SPA (vanilla JS + CSS, no CDNs)
  index.html                app shell + hash router
  styles.css                dark glassmorphism design system + role themes
  app.js                    auth · role-guarded views: teacher (home/bank/assign) · student (home/setup/interview/report/history/mine)
server/
  index.js                  Express entry, static serving, error handling
  routes.js                 REST API + resume extraction (multer/pdf-parse/mammoth)
  auth.js                   dependency-free accounts: scrypt hashing + cookie tokens + role middleware
  config.js                 env config (.env)
  db.js                     SQLite persistence (node:sqlite) — users, auth_tokens, sessions + turns
  rag.js                    RAG retriever: profile inference + ranked retrieval
  embed.js                  sparse lexical embeddings (words + char trigrams)
  interview.js              adaptive state machine (difficulty, coverage, follow-ups)
  ml.js                     feature extraction + logistic-regression classifier
  llm.js                    OpenRouter client + graceful offline fallback
data/
  knowledge-base.json       curated question bank + role/topic/company taxonomies
  sessions.db               local SQLite database (gitignored)
tests/
  smoke.js                  authenticated end-to-end API smoke test
```

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server + KB + LLM status |
| POST | `/api/auth/register` | Create an account (role: `teacher` \| `student`) → logged in |
| POST | `/api/auth/login` / `/api/auth/logout` | Session management (HttpOnly cookie) |
| GET | `/api/auth/me` | Current user (or `{ user: null }`) |
| GET | `/api/meta/roles` | Available roles & companies |
| GET/POST/PUT/DELETE | `/api/questions` (+ `/:id`) | Question-bank CRUD — **teachers only** |
| GET | `/api/teacher/students` | Student roster — **teachers only** |
| POST | `/api/teacher/assign` | Assign an interview to a student — **teachers only** |
| POST | `/api/resume/extract` | Upload resume → extracted text |
| POST | `/api/sessions` | Create session (JD + resume + options) → opening question |
| GET | `/api/sessions` | History (students see their own; teachers see all) |
| GET | `/api/sessions/:id` | Full record (turns + report) — ownership-checked |
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
node tests/smoke.js   # auth → interview → report → teacher assign → ownership + role guards
```

## 🗺️ Roadmap

- [ ] Neural embeddings (`@huggingface/transformers`) swap-in for the RAG retriever
- [ ] Real human-labeled answer dataset to retrain the ML classifier
- [ ] Voice output (text-to-speech) for the interviewer
- [ ] Curated question bank expansion + community contributions
- [ ] Webhooks to fold the report into HireAI's mock-interview feature
