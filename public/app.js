/* ============================================================
   InterviewIQ — frontend app
   Zero-dependency SPA: views, API client, voice input, charts
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = document.getElementById('app');

  const state = {
    sessionId: null,
    profile: null,
    busy: false,
    interviewing: false,
  };

  // ------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Renders **bold** and • bullets to HTML (input is escaped). */
  function md(s) {
    const parts = esc(s).split(/\n+/);
    return parts
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('•') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return `<span class="list-item" style="display:flex;gap:8px;align-items:flex-start;"><span class="dot" style="margin-top:7px;background:var(--accent-2);flex-shrink:0;width:7px;height:7px;border-radius:50%;"></span><span>${line.replace(/^[•\-*]\s+/, '')}</span></span>`;
        }
        return line;
      })
      .join('<br/>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function toast(msg, ms = 3200) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function scoreClass(s) {
    if (s == null) return 'none';
    if (s >= 70) return 'high';
    if (s >= 50) return 'mid';
    return 'low';
  }

  const loading = (label = 'Loading…') =>
    `<div class="loading"><div class="spinner"></div><div>${esc(label)}</div></div>`;

  // ------------------------------------------------------------
  // API client
  // ------------------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ------------------------------------------------------------
  // Router
  // ------------------------------------------------------------
  const routes = {
    home: renderHome,
    setup: renderSetup,
    interview: renderInterview,
    report: renderReport,
    history: renderHistory,
  };

  function navigate() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [route, param] = hash.split('/');
    const fn = routes[route] || renderHome;
    setNavActive(route);
    fn(param);
  }

  function setNavActive(route) {
    document.querySelectorAll('.nav-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === route);
    });
  }

  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------
  // HOME
  // ------------------------------------------------------------
  async function renderHome() {
    app.innerHTML = `
      <section class="hero view">
        <span class="eyebrow">✦ Mock interview co-pilot</span>
        <h1>Land your next role with<br/><span class="grad-text">a personalized AI interviewer</span></h1>
        <p>Upload your resume and a job description. Our RAG engine builds a question bank for your exact role, an adaptive AI interviewer quizzes you, ML scores your answers on STAR &amp; structure, and reports track your improvement across sessions.</p>
        <div class="hero-actions">
          <button class="btn" onclick="location.hash='#/setup'">🚀 Start an interview</button>
          <button class="btn btn-ghost" onclick="location.hash='#/history'">📈 View history</button>
        </div>
      </section>
      <section class="feature-grid view" id="features">
        <div class="feature"><div class="icon">🧠</div><h3>RAG question bank</h3><p>Retrieves the most relevant questions for your role, skills, and target company from a curated knowledge base.</p></div>
        <div class="feature"><div class="icon">🤖</div><h3>Adaptive interviewer</h3><p>An LLM co-pilot that asks questions, fires smart follow-ups, and adjusts difficulty to your answers.</p></div>
        <div class="feature"><div class="icon">📊</div><h3>ML answer scoring</h3><p>A lightweight classifier grades STAR structure, filler words, relevance, and quantified evidence — not just an LLM opinion.</p></div>
        <div class="feature"><div class="icon">🎤</div><h3>Voice answers</h3><p>Answer out loud using your browser's microphone — speech-to-text does the typing.</p></div>
        <div class="feature"><div class="icon">📋</div><h3>Post-interview report</h3><p>Strengths, gaps, and concrete resources — with multi-session tracking that charts your improvement.</p></div>
        <div class="feature"><div class="icon">🔒</div><h3>100% local-first</h3><p>Everything runs on your machine. Sessions are stored in a local SQLite database; no account, no cloud sync.</p></div>
      </section>
      <div class="home-stats view" id="home-stats">
        <div class="stat"><div class="num grad-text" id="st-q">–</div><div class="lbl">questions</div></div>
        <div class="stat"><div class="num grad-text" id="st-r">–</div><div class="lbl">roles</div></div>
        <div class="stat"><div class="num grad-text" id="st-t">–</div><div class="lbl">topics</div></div>
        <div class="stat"><div class="num grad-text" id="st-s">–</div><div class="lbl">sessions</div></div>
      </div>`;
    api('/health').then((h) => {
      $('#st-q').textContent = h.kb.questions;
      $('#st-r').textContent = h.kb.roles;
      $('#st-t').textContent = h.kb.topics;
      $('#st-s').textContent = h.sessions;
    }).catch(() => {});
  }

  // ------------------------------------------------------------
  // SETUP
  // ------------------------------------------------------------
  async function renderSetup() {
    app.innerHTML = `
      <section class="view">
        <h2 class="section-title">New mock interview</h2>
        <p class="section-sub">Two inputs, one click. We'll handle the question bank and the interviewer.</p>
        <div class="card" style="padding:26px;">
          <div class="setup-grid">
            <div>
              <div class="field">
                <label>Resume <span class="hint">.pdf, .docx, or .txt — optional</span></label>
                <div class="dropzone" id="dropzone">
                  <div class="dz-icon">📄</div>
                  <div class="dz-title">Drop your resume here</div>
                  <div class="dz-sub">or click to browse · we extract the text locally</div>
                  <input type="file" id="resumeFile" accept=".pdf,.docx,.txt" hidden />
                </div>
                <div id="fileChip"></div>
              </div>
              <div class="field">
                <label>Job description <span class="hint">paste or auto-fill from resume</span></label>
                <textarea class="textarea" id="jdInput" placeholder="Paste the job description here…"></textarea>
              </div>
              <div class="profile-detect" id="profileDetect"></div>
            </div>
            <div>
              <div class="two-col">
                <div class="field">
                  <label>Role <span class="hint">auto-detected</span></label>
                  <select class="input" id="roleSelect"><option value="">✨ Auto-detect</option></select>
                </div>
                <div class="field">
                  <label>Company <span class="hint">optional</span></label>
                  <select class="input" id="companySelect"><option value="">None</option></select>
                </div>
              </div>
              <div class="field">
                <label>Number of questions</label>
                <div class="range-row">
                  <input type="range" id="qCount" min="3" max="12" value="6" />
                  <span class="range-val" id="qCountVal">6</span>
                </div>
              </div>
              <div class="field">
                <label>How it works</label>
                <div style="font-size:13.5px;color:var(--text-dim);line-height:1.75;">
                  <div>1️⃣ We infer your role, skills &amp; target company (RAG)</div>
                  <div>2️⃣ An AI interviewer asks adaptive questions</div>
                  <div>3️⃣ Each answer is ML-scored on STAR, structure &amp; clarity</div>
                  <div>4️⃣ You get a report + improvement tracking</div>
                </div>
              </div>
            </div>
          </div>
          <div class="setup-actions">
            <button class="btn" id="startBtn">🎯 Start interview</button>
            <button class="btn btn-ghost" onclick="location.hash='#/home'">Cancel</button>
            <span class="faint" id="setupStatus" style="font-size:13px;"></span>
          </div>
        </div>
      </section>`;

    const dropzone = $('#dropzone');
    const fileInput = $('#resumeFile');
    const jdInput = $('#jdInput');
    const profileDetect = $('#profileDetect');
    const statusEl = $('#setupStatus');
    let resumeText = '';

    // Load role/company options
    api('/meta/roles').then((m) => {
      $('#roleSelect').insertAdjacentHTML('beforeend', m.roles.filter((r) => r.id !== 'general').map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join(''));
      $('#companySelect').insertAdjacentHTML('beforeend', m.companies.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join(''));
    }).catch(() => {});

    $('#qCount').addEventListener('input', (e) => { $('#qCountVal').textContent = e.target.value; });

    const pickFile = () => fileInput.click();
    dropzone.addEventListener('click', pickFile);
    fileInput.addEventListener('change', () => fileInput.files[0] && uploadResume(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
    dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) uploadResume(f); });

    async function uploadResume(file) {
      statusEl.textContent = `Extracting text from ${file.name}…`;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await api('/resume/extract', { method: 'POST', body: fd });
        resumeText = res.text;
        $('#fileChip').innerHTML = `<div class="file-chip"><span>✅</span><span class="fc-name">${esc(res.fileName)}</span><span class="fc-meta">${res.chars} chars extracted</span></div>`;
        statusEl.textContent = '';
        if (!jdInput.value.trim()) jdInput.value = '';
        detectProfile();
      } catch (err) {
        statusEl.textContent = '';
        toast('⚠️ ' + err.message, 5000);
      }
    }

    function detectProfile() {
      const text = (jdInput.value + '\n' + resumeText).trim();
      if (text.length < 30) { profileDetect.classList.remove('show'); return; }
      const lower = text.toLowerCase();
      const roles = {
        'software engineer / sde': ['software engineer', 'sde', 'developer', 'full stack', 'programmer'],
        'frontend developer': ['frontend', 'react', 'angular', 'vue', 'ui developer'],
        'backend developer': ['backend', 'node', 'java', 'spring', 'microservice'],
        'data scientist / ml': ['data scientist', 'machine learning', 'ml engineer', 'data science', 'statistics'],
        'product manager': ['product manager', 'product owner', 'program manager'],
        'devops / cloud': ['devops', 'sre', 'site reliability', 'kubernetes', 'ci/cd'],
        'qa / test': ['qa', 'quality assurance', 'test engineer', 'automation tester'],
      };
      let best = null, bestScore = 0;
      for (const [label, kws] of Object.entries(roles)) {
        const s = kws.reduce((acc, k) => acc + (lower.includes(k) ? 1 : 0), 0);
        if (s > bestScore) { bestScore = s; best = label; }
      }
      const roleIds = {
        'software engineer / sde': 'software-engineer',
        'frontend developer': 'frontend',
        'backend developer': 'backend',
        'data scientist / ml': 'data-scientist',
        'product manager': 'product-manager',
        'devops / cloud': 'devops',
        'qa / test': 'qa',
      };
      if (best) {
        profileDetect.innerHTML = `🔍 Detected profile: <strong>${esc(best)}</strong>${bestScore > 1 ? ' (high confidence)' : ''}. Adjust the role dropdown if needed.`;
        profileDetect.classList.add('show');
        if (!$('#roleSelect').value && roleIds[best]) $('#roleSelect').value = roleIds[best];
      } else {
        profileDetect.innerHTML = '🤔 Could not confidently detect a role — pick one manually or leave auto-detect.';
        profileDetect.classList.add('show');
      }
    }

    jdInput.addEventListener('input', detectProfile);

    $('#startBtn').addEventListener('click', async () => {
      const jd = jdInput.value.trim();
      if (!jd && !resumeText) return toast('Add a job description or resume first.');
      const btn = $('#startBtn');
      btn.disabled = true;
      btn.textContent = 'Preparing your interview…';
      try {
        const session = await api('/sessions', {
          method: 'POST',
          body: JSON.stringify({
            role: $('#roleSelect').value || undefined,
            company: $('#companySelect').value || undefined,
            jd,
            resumeText,
            questionCount: Number($('#qCount').value),
          }),
        });
        state.sessionId = session.sessionId;
        state.profile = session.profile;
        try { localStorage.setItem('iq_session', session.sessionId); } catch {}
        location.hash = '#/interview';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '🎯 Start interview';
        toast('⚠️ ' + err.message, 5000);
      }
    });
  }

  // ------------------------------------------------------------
  // INTERVIEW
  // ------------------------------------------------------------
  async function renderInterview() {
    let sessionId = state.sessionId || (() => { try { return localStorage.getItem('iq_session'); } catch { return null; } })();
    if (!sessionId) return location.hash = '#/setup';
    const res = await api(`/sessions/${sessionId}`).catch(() => null);
    if (!res) return location.hash = '#/home';
    const { session, turns } = res;
    state.sessionId = sessionId;
    state.profile = session.profile;
    const total = session.state?.totalQuestions || turns.filter((t) => t.kind === 'question').length || 6;

    app.innerHTML = `
      <section class="view">
        <div class="interview-header">
          <div class="ih-left">
            <div class="avatar">🤖</div>
            <div>
              <div class="ih-title">Live mock interview</div>
              <div class="ih-sub">${esc(session.profile.roleLabel || 'General')}${session.company ? ' · ' + esc(session.profile.companyLabel || session.company) : ''}</div>
            </div>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar"><div class="progress-fill" id="progFill" style="width:0%"></div></div>
            <div class="progress-label" id="progLabel"></div>
          </div>
          <div class="diff-meter" title="Difficulty">
            <span id="diffSegs"></span><span class="diff-label" id="diffLabel"></span>
          </div>
        </div>
        <div class="chat" id="chat"></div>
        <div class="composer" id="composerWrap">
          <button class="mic-btn" id="micBtn" title="Answer with your voice (Chrome/Edge)">🎤</button>
          <textarea class="textarea" id="answerInput" placeholder="Type your answer… (Ctrl+Enter to send)"></textarea>
          <button class="btn send-btn" id="sendBtn" title="Send answer">➤</button>
        </div>
        <div class="interview-footer">
          <button class="btn btn-ghost btn-sm" id="endBtn">🏁 End interview &amp; get report</button>
          <span class="faint" id="engineTag" style="font-size:12px;"></span>
        </div>
      </section>`;

    const chat = $('#chat');
    const input = $('#answerInput');
    const sendBtn = $('#sendBtn');
    const micBtn = $('#micBtn');
    const endBtn = $('#endBtn');

    const apiStatus = await api('/health');
    $('#engineTag').textContent = apiStatus.llm ? 'LLM engine: ' + apiStatus.model : 'Offline engine (add OpenRouter key in .env for LLM feedback)';

    if (session.status === 'completed') {
      $('#composerWrap').style.display = 'none';
      endBtn.textContent = '📋 View report';
      endBtn.onclick = () => { location.hash = '#/report/' + sessionId; };
      appendBubble('system', '✅ This interview is complete. View your report to see strengths, gaps, and next steps.');
    }

    // Rebuild existing conversation
    for (const t of turns) {
      if (t.kind === 'question' || t.kind === 'followup') {
        appendBubble('ai', bubbleMark(t), t.kind === 'followup' ? 'Follow-up' : null);
      } else if (t.kind === 'answer') {
        appendBubble('user', esc(t.answer));
        if (t.score != null) appendFeedback(t.score, t.feedback);
      }
    }
    updateProgress(turns, total);

    // Auto-scroll
    chat.scrollTop = chat.scrollHeight;

    // ---------- composer actions ----------
    const submit = async () => {
      const text = input.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      appendBubble('user', esc(text));
      input.value = '';
      setComposerDisabled(true);
      showTyping();
      try {
        const r = await api(`/sessions/${sessionId}/answer`, { method: 'POST', body: JSON.stringify({ answer: text }) });
        hideTyping();
        if (r.type === 'followup' || r.type === 'next' || r.type === 'done') {
          appendFeedback(r.score, r.feedback);
          if (r.type === 'followup' && r.followUp) appendBubble('ai', bubbleMark(r.followUp.text), 'Follow-up');
          if (r.type === 'next' && r.next) appendBubble('ai', bubbleMark(r.next.text), r.next.topicLabel || null);
          if (r.type === 'done') {
            appendBubble('system', r.closing || 'Interview complete. Generating report…');
            toast('Generating your report…');
            await api(`/sessions/${sessionId}/complete`, { method: 'POST' });
            location.hash = '#/report/' + sessionId;
            return;
          }
        }
        updateProgressFrom(r);
        state.busy = false;
        setComposerDisabled(false);
        input.focus();
      } catch (err) {
        hideTyping();
        state.busy = false;
        setComposerDisabled(false);
        appendBubble('system', '⚠️ ' + err.message);
      }
    };

    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') submit(); });

    // Voice input
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognizer = null;
    let listening = false;
    if (SR) {
      micBtn.addEventListener('click', () => {
        if (listening) { recognizer.stop(); return; }
        recognizer = new SR();
        recognizer.lang = 'en-IN';
        recognizer.interimResults = true;
        recognizer.continuous = false;
        recognizer.onresult = (e) => {
          let interim = '', final = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) final += r[0].transcript;
            else interim += r[0].transcript;
          }
          input.value = (input.value ? input.value + ' ' : '') + final;
          if (interim) input.value += ' ' + interim;
          chat.scrollTop = chat.scrollHeight;
        };
        recognizer.onend = () => {
          listening = false;
          micBtn.classList.remove('listening');
          micBtn.textContent = '🎤';
        };
        recognizer.onerror = (e) => {
          if (e.error !== 'no-speech') toast('🎤 Mic error: ' + e.error);
          listening = false;
          micBtn.classList.remove('listening');
          micBtn.textContent = '🎤';
        };
        listening = true;
        micBtn.classList.add('listening');
        micBtn.textContent = '⏹';
        try { recognizer.start(); } catch { listening = false; micBtn.classList.remove('listening'); micBtn.textContent = '🎤'; }
      });
    } else {
      micBtn.style.opacity = 0.4;
      micBtn.title = 'Voice input not supported in this browser (try Chrome/Edge)';
    }

    endBtn.addEventListener('click', async () => {
      if (state.busy) return;
      endBtn.disabled = true;
      endBtn.textContent = 'Generating report…';
      showTyping();
      try {
        await api(`/sessions/${sessionId}/complete`, { method: 'POST' });
        location.hash = '#/report/' + sessionId;
      } catch (err) {
        hideTyping();
        endBtn.disabled = false;
        endBtn.textContent = '🏁 End interview & get report';
        toast('⚠️ ' + err.message, 4000);
      }
    });

    function bubbleMark(text, topic) {
      return `<span class="topic-tag">${topic ? esc(topic) : ''}</span>${md(text)}`;
    }

    function showTyping() {
      const div = document.createElement('div');
      div.className = 'msg ai';
      div.id = 'typingMsg';
      div.innerHTML = `<div class="msg-avatar">🤖</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }
    function hideTyping() { const t = $('#typingMsg'); if (t) t.remove(); }

    function setComposerDisabled(d) {
      input.disabled = d;
      sendBtn.disabled = d;
      endBtn.disabled = d;
    }

    function updateProgress(turnsArr, totalQ) {
      const mainAnswers = session.state?.answeredQuestions ?? turnsArr.filter((t) => t.kind === 'answer').length;
      const answered = Math.min(mainAnswers, totalQ);
      const pct = Math.min(100, Math.round((answered / totalQ) * 100));
      $('#progFill').style.width = pct + '%';
      $('#progLabel').textContent = `${answered}/${totalQ} answered · ${state.profile?.companyLabel || ''}`;
    }

    function updateProgressFrom(r) {
      const answered = Math.round((r.progress ?? 0) * (session.state?.totalQuestions || total));
      const pct = Math.min(100, Math.round((r.progress ?? 0) * 100));
      $('#progFill').style.width = pct + '%';
      $('#progLabel').textContent = `${answered}/${total} answered · ${state.profile?.companyLabel || ''}`;
    }

    function appendBubble(role, html, tag) {
      const div = document.createElement('div');
      div.className = `msg ${role}`;
      div.innerHTML = `<div class="msg-avatar">${role === 'ai' ? '🤖' : '🧑‍💻'}</div><div class="bubble">${tag ? `<span class="topic-tag">${esc(tag)}</span>` : ''}${html}</div>`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function appendFeedback(score, feedback) {
      const cls = scoreClass(score);
      const div = document.createElement('div');
      div.className = 'msg ai';
      const chip = score >= 70 ? '🎯 Strong' : score >= 50 ? '⚖️ Developing' : '🌱 Needs work';
      div.innerHTML = `<div class="msg-avatar">📊</div><div class="bubble">${md(feedback)}<div><span class="feedback-chip ${cls}">${chip} · ${score}/100</span></div></div>`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }
  }

  // ------------------------------------------------------------
  // REPORT
  // ------------------------------------------------------------
  async function renderReport(sessionId) {
    const id = sessionId || (location.hash.match(/report\/(.+)/) || [])[1];
    if (!id) return location.hash = '#/home';
    app.innerHTML = loading('Preparing your report…');
    const res = await api(`/sessions/${id}`).catch(() => null);
    if (!res || !res.session) return location.hash = '#/home';
    const { session, turns } = res;
    const report = session.report;
    if (!report) {
      app.innerHTML = `<section class="view empty-state"><div class="e-icon">⏳</div><h3>Report not ready</h3><p>This interview hasn't been completed yet.</p><button class="btn" onclick="location.hash='#/history'">Back to history</button></section>`;
      return;
    }
    const questionTurns = turns.filter((t) => t.kind === 'question' || t.kind === 'followup');
    const answers = turns.filter((t) => t.kind === 'answer');

    // improvement data: last 10 completed sessions (history is newest-first)
    const history = await api('/sessions');
    const completed = history.sessions.filter((s) => s.status === 'completed' && s.totalScore != null).slice(0, 10).reverse();

    app.innerHTML = `
      <section class="view">
        <div class="report-hero">
          <span class="eyebrow">📋 Post-interview report</span>
          <h2 class="section-title">${esc(session.profile.roleLabel || 'Interview')}${session.company ? ' at ' + esc(session.profile.companyLabel || '') : ''}</h2>
          <div class="muted" style="font-size:13.5px;">${new Date(session.completedAt || session.createdAt).toLocaleString()} · ${answers.length} answers</div>
          <div class="gauge-wrap" style="margin-top:26px;">
            <div class="gauge">
              <svg width="190" height="190" viewBox="0 0 190 190">
                <circle cx="95" cy="95" r="80" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="13"/>
                <circle id="gaugeArc" cx="95" cy="95" r="80" fill="none" stroke="url(#gGrad)" stroke-width="13" stroke-linecap="round" stroke-dasharray="502" stroke-dashoffset="502"/>
                <defs><linearGradient id="gGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient></defs>
              </svg>
              <div class="g-num"><div><span id="gNum">0</span><small>/100</small></div></div>
              <div class="g-lvl" id="gLvl"></div>
            </div>
          </div>
          <div class="improvement ${report.improvementDelta == null ? 'flat' : report.improvementDelta >= 0 ? 'up' : 'down'}" id="improveBox"></div>
        </div>

        <div class="report-grid">
          <div>
            <div class="card report-card">
              <h3>📝 Summary</h3>
              <p style="font-size:14.5px;line-height:1.75;">${md(report.summary || '')}</p>
              ${report.companyThemes && report.companyThemes.length ? `<div style="margin-top:14px;font-size:13px;color:var(--text-dim);line-height:1.7;">🏢 <strong>Company patterns to internalize:</strong><br/>${report.companyThemes.map((t) => '• ' + esc(t)).join('<br/>')}</div>` : ''}
            </div>
            <div class="card report-card" style="margin-top:18px;">
              <h3>📊 Criteria breakdown</h3>
              <div class="criteria-list" id="criteriaList"></div>
            </div>
            <div class="card report-card" style="margin-top:18px;">
              <h3>🧭 Topic performance</h3>
              <div class="topic-bars" id="topicBars"></div>
            </div>
          </div>
          <div>
            <div class="card report-card">
              <h3>💪 Strengths</h3>
              <div class="list-items" id="strengths"></div>
            </div>
            <div class="card report-card" style="margin-top:18px;">
              <h3>🎯 Gaps to close</h3>
              <div class="list-items" id="gaps"></div>
            </div>
            <div class="card report-card" style="margin-top:18px;">
              <h3>📚 Recommended resources</h3>
              <div style="display:flex;flex-direction:column;gap:10px;" id="resources"></div>
            </div>
            <div class="card report-card" style="margin-top:18px;">
              <h3>🛰️ Radar</h3>
              <div class="radar-wrap" id="radar"></div>
            </div>
          </div>
        </div>

        <div class="turn-list">
          <h3 class="section-title" style="font-size:20px;">Question-by-question</h3>
          <div id="turns"></div>
        </div>

        <div style="display:flex;gap:12px;margin-top:28px;flex-wrap:wrap;">
          <button class="btn" onclick="location.hash='#/setup'">🔄 Another interview</button>
          <button class="btn btn-ghost" onclick="location.hash='#/history'">📈 All sessions</button>
          <button class="btn btn-ghost" onclick="location.hash='#/home'">🏠 Home</button>
        </div>
      </section>`;

    // Animate gauge
    const gNum = $('#gNum');
    const arc = $('#gaugeArc');
    const target = session.totalScore || 0;
    requestAnimationFrame(() => {
      const t0 = performance.now();
      const dur = 1200;
      (function tick(now) {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        gNum.textContent = Math.round(target * eased);
        arc.style.strokeDashoffset = 502 - 502 * (target / 100) * eased;
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
    $('#gLvl').textContent = levelLabel(report.level);
    const deltaMsg = report.improvementDelta == null
      ? '📌 First session — take more interviews to chart your improvement curve.'
      : (report.improvementDelta >= 0 ? '📈' : '📉') + ` This run is <strong>${report.improvementDelta >= 0 ? '+' : ''}${report.improvementDelta} pts</strong> vs. your previous average (${report.previousAvg ?? '–'}).`;
    const spark = sparklineHTML(completed);
    $('#improveBox').innerHTML = `<div>${deltaMsg}</div>${spark}`;

    // Criteria bars
    const critMap = { star: 'STAR structure', relevance: 'Relevance', structure: 'Structure', clarity: 'Clarity', evidence: 'Quantified evidence' };
    $('#criteriaList').innerHTML = Object.entries(critMap).map(([k, label]) => {
      const v = report.perCriterion?.[k] ?? 0;
      return `<div class="criterion"><div class="cr-head"><span>${label}</span><span class="cr-val">${v}</span></div><div class="cr-track"><div class="cr-fill" data-w="0" data-target="${v}" style="width:0%"></div></div></div>`;
    }).join('');

    // Topic bars
    const topics = Object.entries(report.perTopic || {}).sort((a, b) => b[1].avg - a[1].avg);
    $('#topicBars').innerHTML = topics.length
      ? topics.map(([t, s]) => `<div class="topic-bar"><div class="tb-head"><span>${esc(t)}</span><span>${s.avg}<span class="tb-count"> · ${s.count}q</span></span></div><div class="cr-track"><div class="cr-fill" data-w="0" data-target="${s.avg}" style="width:0%"></div></div></div>`).join('')
      : '<div class="muted">No scored answers yet.</div>';

    // Strengths / gaps
    $('#strengths').innerHTML = (report.strengths || []).map((s) => `<div class="list-item good"><span class="dot"></span><span><strong>${esc(s.label)}</strong> — avg ${s.avg}/100 over ${s.count} question(s)</span></div>`).join('') || '<div class="muted">Add detail to your answers to surface strengths.</div>';
    $('#gaps').innerHTML = (report.gaps || []).map((g) => `<div class="list-item bad"><span class="dot"></span><span><strong>${esc(g.label)}</strong> — avg ${g.avg}/100. Practice makes perfect.</span></div>`).join('') || '<div class="muted">No gaps detected — keep it up!</div>';

    // Resources
    $('#resources').innerHTML = (report.resources || []).map((r) => `<div class="resource-item"><span class="r-icon">📌</span><span>${esc(r)}</span></div>`).join('') || '<div class="muted">No resources suggested.</div>';

    // Radar
    renderRadar(report.perCriterion || {});

    // Question-by-question (each answer pairs with the question that preceded it)
    const turnHTML = answers.map((a, i) => {
      const q = questionTurns[i] || { question: a.question || '…' };
      const s = a.score;
      const crit = a.scoreJson?.criteria || {};
      return `
        <div class="card turn-card">
          <div class="tc-q">❓ ${md(a.question || '')} ${a.topic ? `<span class="pill t-tag">${esc(a.topic)}</span>` : ''}</div>
          <div class="tc-a">${esc(a.answer || '')}</div>
          <div class="turn-score-row">
            <div class="turn-score ${scoreClass(s)}">${s}</div>
            <div class="turn-criteria">
              ${Object.entries({ star: 'STAR', relevance: 'Rel', structure: 'Struct', clarity: 'Clar', evidence: 'Evid' }).map(([k, lbl]) => `<span class="pill">${lbl} ${crit[k] ?? '–'}</span>`).join('')}
            </div>
          </div>
          ${a.feedback ? `<div style="margin-top:12px;font-size:13.5px;color:var(--text-dim);line-height:1.6;">${md(a.feedback)}</div>` : ''}
        </div>`;
    }).join('');
    $('#turns').innerHTML = turnHTML || '<div class="empty-state"><div class="e-icon">🗒️</div><h3>No answers recorded</h3><p>Finish an interview to see the breakdown.</p></div>';

    // Animate criteria/topic bars
    setTimeout(() => {
      document.querySelectorAll('.cr-fill[data-target]').forEach((el) => { el.style.width = Math.min(100, el.dataset.target) + '%'; });
    }, 150);
  }

  function sparklineHTML(sessions) {
    const list = sessions.filter((s) => s.totalScore != null);
    if (list.length < 2) return '';
    const max = Math.max(...list.map((s) => s.totalScore), 1);
    const w = 460, h = 74, pad = 4;
    const bw = Math.min(34, (w - pad * 2) / list.length - 6);
    const bars = list.map((s, i) => {
      const bh = Math.max(4, (s.totalScore / max) * (h - 26));
      const x = pad + i * ((w - pad * 2) / list.length);
      const y = h - bh - 18;
      const last = i === list.length - 1;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="4" fill="${last ? 'url(#spGrad)' : 'rgba(148,163,184,0.45)'}" opacity="0.9"><title>${new Date(s.createdAt).toLocaleDateString()}: ${s.totalScore}/100</title></rect>`;
    }).join('');
    const labels = `<text x="${pad}" y="${h - 4}" fill="#6b7490" font-size="10">oldest</text><text x="${w - pad}" y="${h - 4}" fill="#6b7490" font-size="10" text-anchor="end">now</text>`;
    return `<svg width="100%" viewBox="0 0 ${w} ${h}" style="margin-top:10px;max-width:420px;"><defs><linearGradient id="spGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#6366f1"/></linearGradient></defs>${bars}${labels}</svg>`;
  }

  function levelLabel(level) {
    const map = { strong: '🥇 Strong performance', solid: '🥈 Solid performance', developing: '🥉 Developing — good start', 'needs-practice': '🔧 Needs practice — you got this' };
    return map[level] || level;
  }

  function renderRadar(crit) {
    const labels = [['star', 'STAR'], ['relevance', 'Relevance'], ['structure', 'Structure'], ['clarity', 'Clarity'], ['evidence', 'Evidence']];
    const size = 260, cx = 130, cy = 130, r = 92;
    let poly = '', grid = '';
    labels.forEach(([k], i) => {
      const ang = (Math.PI * 2 * i) / labels.length - Math.PI / 2;
      const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
      grid += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(255,255,255,0.08)"/>`;
      const lx = cx + (r + 20) * Math.cos(ang), ly = cy + (r + 20) * Math.sin(ang);
      grid += `<text x="${lx}" y="${ly}" fill="#9aa4bf" font-size="10" text-anchor="middle" dominant-baseline="middle">${labels[i][1]}</text>`;
    });
    for (const ring of [0.33, 0.66, 1]) {
      grid += `<polygon points="${labels.map(([k], i) => { const ang = (Math.PI * 2 * i) / labels.length - Math.PI / 2; return `${cx + r * ring * Math.cos(ang)},${cy + r * ring * Math.sin(ang)}`; }).join(' ')}" fill="none" stroke="rgba(255,255,255,0.07)"/>`;
    }
    poly = labels.map(([k], i) => {
      const ang = (Math.PI * 2 * i) / labels.length - Math.PI / 2;
      const v = (crit[k] ?? 0) / 100;
      return `${cx + r * v * Math.cos(ang)},${cy + r * v * Math.sin(ang)}`;
    }).join(' ');
    const wrap = $('#radar');
    if (!wrap) return;
    wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${grid}
      <polygon points="${poly}" fill="rgba(99,102,241,0.28)" stroke="#818cf8" stroke-width="2">
        <animate attributeName="opacity" values="0;1" dur="0.8s"/>
      </polygon></svg>`;
  }

  // ------------------------------------------------------------
  // HISTORY
  // ------------------------------------------------------------
  async function renderHistory() {
    app.innerHTML = loading('Loading your sessions…');
    const res = await api('/sessions').catch(() => ({ sessions: [] }));
    const sessions = res.sessions;

    if (!sessions.length) {
      app.innerHTML = `
        <section class="view empty-state">
          <div class="e-icon">🗂️</div>
          <h3>No interviews yet</h3>
          <p>Your session history — scores, reports, and improvement curves — will appear here.</p>
          <button class="btn" onclick="location.hash='#/setup'">🎯 Start your first interview</button>
        </section>`;
      return;
    }

    app.innerHTML = `
      <section class="view">
        <h2 class="section-title">Session history</h2>
        <p class="section-sub">Every session is stored locally. Watch your average climb.</p>
        <div class="card" style="padding:8px 14px;overflow-x:auto;">
          <table class="history-table">
            <thead><tr><th>Date</th><th>Role</th><th>Company</th><th>Questions</th><th>Score</th><th>Status</th></tr></thead>
            <tbody>
              ${sessions.map((s) => `
                <tr onclick="location.hash='#/report/${s.id}'">
                  <td>${new Date(s.createdAt).toLocaleString()}</td>
                  <td>${esc(s.role || 'general')}</td>
                  <td>${esc(s.company || '—')}</td>
                  <td>${s.questionCount ?? '–'}</td>
                  <td><span class="score-badge ${scoreClass(s.totalScore)}">${s.totalScore != null ? s.totalScore + '/100' : '–'}</span></td>
                  <td><span class="pill">${s.status === 'completed' ? '✅ completed' : '⏳ in progress'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------
  if (!location.hash) location.hash = '#/home';
  navigate();
})();
