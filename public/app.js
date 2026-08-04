/* ============================================================
   InterviewIQ — frontend app
   Zero-dependency SPA: auth, role-based workspaces, views,
   API client, voice input, charts
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = document.getElementById('app');

  const state = {
    user: null,       // { id, username, role }
    sessionId: null,
    profile: null,
    busy: false,
    interviewing: false,
    meta: null,       // cached role/company taxonomy
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

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  const loading = (label = 'Loading…') =>
    `<div class="loading"><div class="spinner"></div><div>${esc(label)}</div></div>`;

  // ------------------------------------------------------------
  // Theme, mobile nav, landing scroll helpers
  // ------------------------------------------------------------
  function initTheme() {
    let saved = 'light';
    try { saved = localStorage.getItem('iq_theme') || 'light'; } catch {}
    document.body.dataset.theme = saved;
  }

  function toggleTheme() {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    try { localStorage.setItem('iq_theme', next); } catch {}
  }

  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.scrollToSection = scrollToSection;

  /** Scrolls to a landing section; navigates to the landing page first if needed. */
  function goToSection(id) {
    if (document.getElementById(id)) { scrollToSection(id); return; }
    location.hash = '#/';
    setTimeout(() => scrollToSection(id), 120);
  }
  window.goToSection = goToSection;

  function setupBurger() {
    const burger = $('#burger');
    const nav = $('#topnav');
    if (!burger || !nav) return;
    burger.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      burger.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('.nav-link')) {
        nav.classList.remove('open');
        burger.classList.remove('open');
      }
    });
  }

  /** Observes .reveal elements and fades them in once visible. */
  function bindReveals(root) {
    const els = (root || document).querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
  }

  /** Animates a counter element from 0 to its data-count (or text) target. */
  function animateCounters(root) {
    const els = (root || document).querySelectorAll('[data-count]');
    const run = (el) => {
      const target = Number(el.dataset.count || 0);
      const suffix = el.dataset.suffix || '';
      const dur = 1300;
      const t0 = performance.now();
      (function tick(now) {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    };
    if (!('IntersectionObserver' in window)) { els.forEach(run); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { run(en.target); io.unobserve(en.target); }
      });
    }, { threshold: 0.4 });
    els.forEach((el) => io.observe(el));
  }

  // ------------------------------------------------------------
  // API client
  // ------------------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth')) {
        state.user = null;
        document.body.dataset.role = 'guest';
        renderNav();
        location.hash = '#/auth';
      }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  // ------------------------------------------------------------
  // Auth helpers
  // ------------------------------------------------------------
  const isTeacher = () => state.user && state.user.role === 'teacher';

  function applyRole() {
    document.body.dataset.role = state.user ? state.user.role : 'guest';
  }

  async function loadMeta() {
    if (state.meta) return state.meta;
    try {
      state.meta = await api('/meta/roles');
    } catch {
      state.meta = { roles: [], companies: [] };
    }
    return state.meta;
  }

  // ------------------------------------------------------------
  // Top bar (role-aware)
  // ------------------------------------------------------------
  function renderNav() {
    const nav = $('#topnav');
    const right = $('#topbarRight');
    const themeBtn = `<button class="theme-toggle" id="themeBtn" title="Toggle dark mode">${document.body.dataset.theme === 'dark' ? '☀️' : '🌙'}</button>`;
    if (!state.user) {
      nav.innerHTML = `
        <button class="nav-link" data-anchor="problem" onclick="goToSection('problem')">Problem</button>
        <button class="nav-link" data-anchor="solution" onclick="goToSection('solution')">Solution</button>
        <button class="nav-link" data-anchor="features" onclick="goToSection('features')">Features</button>
        <button class="nav-link" data-anchor="how" onclick="goToSection('how')">How it works</button>
        <button class="nav-link" data-anchor="vision" onclick="goToSection('vision')">Vision</button>`;
      right.innerHTML = `${themeBtn}<a href="#/auth" class="nav-link" data-route="auth">Log in</a><a class="btn nav-cta" href="#/auth">Request Demo</a>`;
      const tb = $('#themeBtn');
      if (tb) tb.addEventListener('click', () => { toggleTheme(); tb.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙'; });
      return;
    }
    const links = isTeacher()
      ? [['home', '📊 Dashboard'], ['bank', '📚 Question bank'], ['assign', '🎯 Assign interview']]
      : [['home', '🏠 Home'], ['setup', '🚀 New interview'], ['mine', '📥 My interviews'], ['history', '📈 History']];
    nav.innerHTML = links.map(([r, l]) => `<a href="#/${r}" class="nav-link" data-route="${r}">${l}</a>`).join('');
    const icon = isTeacher() ? '👩‍🏫' : '🧑‍🎓';
    right.innerHTML = `
      ${themeBtn}
      <span class="user-chip"><span class="uc-icon">${icon}</span><span class="uc-name">${esc(state.user.username)}</span></span>
      <button class="nav-link logout-btn" id="logoutBtn" title="Log out">Log out</button>`;
    const tb = $('#themeBtn');
    if (tb) tb.addEventListener('click', () => { toggleTheme(); tb.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙'; });
    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch {}
      state.user = null;
      applyRole();
      renderNav();
      location.hash = '#/';
    });
  }

  function setNavActive(route) {
    document.querySelectorAll('#topnav .nav-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === route);
    });
  }

  // ------------------------------------------------------------
  // Router (role-guarded)
  // ------------------------------------------------------------
  const routes = {
    landing: renderLanding,
    auth: renderAuth,
    home: renderHome,
    setup: renderSetup,
    interview: renderInterview,
    report: renderReport,
    history: renderHistory,
    mine: renderMine,
    bank: renderBank,
    assign: renderAssign,
  };

  function navigate() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [route, param] = hash.split('/');

    if (!state.user) {
      if (route === 'auth') {
        setNavActive('auth');
        renderAuth();
        return;
      }
      if (route === '' || route === 'landing') {
        setNavActive('landing');
        renderLanding();
        return;
      }
      location.hash = '#/';
      return;
    }

    const allowed = isTeacher() ? ['home', 'bank', 'assign', 'report'] : ['home', 'setup', 'interview', 'report', 'history', 'mine'];
    if (!allowed.includes(route)) { location.hash = '#/home'; return; }

    setNavActive(route);
    (routes[route] || renderHome)(param);
  }

  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------
  // LANDING (public marketing site)
  // ------------------------------------------------------------
  async function renderLanding() {
    const qs = 78;
    const roles = 6;
    const topics = 15;
    const llm = 'Local AI engine';

    const features = [
      ['🧩', 'AI Code Segmentation', 'Automatically divides experiments into meaningful logical blocks — each with an explanation, walkthrough, and checkpoint.'],
      ['🤖', 'Interactive Learning', 'Checkpoint questions after every block replace passive copying with real understanding.'],
      ['🎤', 'AI Viva', 'Generate viva questions instantly from any experiment, topic, or code block.'],
      ['📝', 'Smart MCQ Generator', 'Teacher selects a topic — AI creates the quiz automatically, ready in seconds.'],
      ['🚀', 'GitHub Portfolio', 'Push every completed experiment to GitHub and build a recruiter-ready portfolio.'],
      ['📊', 'Teacher Analytics', 'Performance dashboards, weak-concept detection, completion rates, and student rankings.'],
      ['✅', 'Attendance Integration', 'Optional attendance linked directly to lab completion — no manual registers.'],
      ['📄', 'AI Notes', 'Generate experiment summaries and documentation automatically, every single time.'],
    ];

    const benefits = [
      ['🎓', 'For Students', [
        'Learn instead of memorizing', 'Build a GitHub portfolio', 'AI explanations on demand', 'Viva preparation built in', 'Faster, deeper learning',
      ]],
      ['👩‍🏫', 'For Teachers', [
        'Zero record checking', 'Automatic quiz generation', 'Live student analytics', 'Instant evaluation', 'Dramatically reduced workload',
      ]],
      ['🏛️', 'For Colleges', [
        'Digital practical records', 'Better student outcomes', 'NBA / NAAC accreditation support', 'Higher placement readiness', 'One platform for every lab',
      ]],
    ];

    const timeline = [
      ['👩‍🎓', 'Student enters the lab', 'Attendance and context captured automatically. No more paper registers.'],
      ['🧠', 'Teacher creates AI quiz', 'Pick previous topics — AI generates an MCQ quiz in seconds.'],
      ['✍️', 'Students complete assessment', 'A focused 10–20 minute check that sets the baseline.'],
      ['📣', 'Teacher explains the experiment', 'Live scores show exactly who is ready before the practical starts.'],
      ['⌨️', 'Teacher pastes the code', 'The experiment source goes in — the AI takes it from there.'],
      ['🧩', 'AI divides code into blocks', 'Logical segments with explanations, questions, and walkthroughs.'],
      ['✅', 'Students answer checkpoints', 'No blind copying — each block must be understood to continue.'],
      ['🏁', 'Experiment completed', 'Every student finishes with genuine understanding, proven.'],
      ['📝', 'AI generates notes', 'Documentation, summaries, and reflection notes — automatically.'],
      ['🚀', 'Student pushes to GitHub', 'A growing portfolio that proves practical skill to recruiters.'],
    ];

    const extras = [
      ['🗣️', 'AI Viva Practice'], ['🏆', 'Leaderboard'], ['📈', 'Semester Progress'], ['🔥', 'Learning Streaks'],
      ['🎖️', 'Achievements'], ['💼', 'Portfolio Builder'], ['📚', 'Experiment Library'], ['📊', 'Analytics Dashboard'],
      ['🌙', 'Dark Mode'], ['🔔', 'Notifications'], ['🔐', 'Role-based Login'], ['🛠️', 'Admin Dashboard'], ['📤', 'Export Reports'],
    ];

    const vision = [
      ['🤖', 'AI Tutor', 'Personal guidance for every student, 24/7.'],
      ['🧪', 'AI Lab Assistant', 'In-lab help whenever a student is stuck.'],
      ['🗣️', 'Automatic Viva', 'Oral exams that grade themselves.'],
      ['💼', 'Placement Portfolio', 'Proof of skill recruiters can verify.'],
      ['📊', 'Skill Analytics', 'Granular insight into every competency.'],
      ['🔬', 'Research Projects', 'Capstone and research workflows included.'],
      ['🏫', 'University ERP Integration', 'One system across the whole campus.'],
      ['🤝', 'Recruiter Access', 'Direct bridge from classroom to hiring.'],
    ];

    const testimonials = [
      ['Ananya', 'Student, CSE · 3rd year', 'I stopped copying code. The checkpoints make sure you actually understand each block before moving on — my viva scores went way up.'],
      ['Dr. Rajesh', 'Faculty, Computer Science', 'I no longer spend evenings checking records. The AI does the evaluation and I get analytics instead of piles of paper.'],
      ['Prof. Meera', 'HOD, ECE Department', 'The weakest-concepts view changed how we plan labs. Attendance, assessment, and portfolios — all in one place.'],
      ['Dr. Srinivas', 'Principal', 'This is exactly the kind of practical-proof infrastructure accreditation bodies and recruiters want to see.'],
    ];

    app.innerHTML = `
      <div class="landing">

        <!-- HERO -->
        <section class="hero-section">
          <div class="l-wrap">
            <span class="hero-badge reveal"><span class="pulse-dot"></span> ${esc(llm)} · Built for colleges</span>
            <h1 class="l-title reveal reveal-delay-1">The Future of<br/><span class="grad-text">Practical Learning</span></h1>
            <p class="l-sub reveal reveal-delay-2">Replace handwritten lab records with AI-powered learning, assessments, and GitHub portfolio generation. One platform for students, teachers, and colleges.</p>
            <div class="hero-actions reveal reveal-delay-3">
              <a class="btn" href="#/auth">Request Demo <span style="font-size:16px;">→</span></a>
              <a class="btn btn-ghost" href="#/" onclick="event.preventDefault();scrollToSection('solution');"><span class="play-ico">▶</span> Watch Demo</a>
            </div>

            <div class="hero-pipeline reveal reveal-delay-3">
              <div class="pipe-stage">
                <div class="pipe-card"><div class="pipe-ico">👩‍🏫</div><div class="pipe-name">Teacher Dashboard</div><div class="pipe-desc">Create, quiz, and monitor</div></div>
                <span class="pipe-arrow">→</span>
                <div class="pipe-card"><div class="pipe-ico">⚡</div><div class="pipe-name">AI Engine</div><div class="pipe-desc">Segment · quiz · explain · score</div></div>
                <span class="pipe-arrow">→</span>
                <div class="pipe-card"><div class="pipe-ico">🧑‍🎓</div><div class="pipe-name">Student Learning</div><div class="pipe-desc">Checkpoints &amp; viva prep</div></div>
                <span class="pipe-arrow">→</span>
                <div class="pipe-card"><div class="pipe-ico">🐙</div><div class="pipe-name">GitHub Portfolio</div><div class="pipe-desc">Proof of every experiment</div></div>
              </div>
              <div class="pipe-flow">
                <span class="pf-chip">Before Lab</span><span class="pf-x">→</span>
                <span class="pf-chip">During Lab</span><span class="pf-x">→</span>
                <span class="pf-chip">After Lab</span><span class="pf-x">→</span>
                <span class="pf-chip">Portfolio Ready</span>
              </div>
            </div>

            <div class="hero-stats">
              <div class="hstat reveal"><div class="hstat-num grad-text" id="st-q" data-count="${qs}">0</div><div class="hstat-lbl">curated questions</div></div>
              <div class="hstat reveal reveal-delay-1"><div class="hstat-num grad-text" id="st-t" data-count="${topics}">0</div><div class="hstat-lbl">learning topics</div></div>
              <div class="hstat reveal reveal-delay-2"><div class="hstat-num grad-text" id="st-r" data-count="${roles}">0</div><div class="hstat-lbl">career roles</div></div>
              <div class="hstat reveal reveal-delay-3"><div class="hstat-num grad-text" id="st-s" data-count="10">0</div><div class="hstat-lbl">AI-powered steps</div></div>
            </div>
          </div>
        </section>

        <!-- PROBLEM -->
        <section class="l-section" id="problem">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ The problem</span>
            <h2 class="l-title reveal">Traditional Labs Are <span class="grad-text">Broken</span></h2>
            <p class="l-sub reveal">Copy-paste practicals teach nothing, and the record book wastes everyone's time.</p>
            <div class="problem-grid">
              <div class="problem-card reveal"><div class="p-ico">📋</div><h3>Copy-paste culture</h3><p>Students copy code without understanding a single line they submit.</p></div>
              <div class="problem-card reveal reveal-delay-1"><div class="p-ico">⏰</div><h3>Hours wasted</h3><p>Hours and hours lost writing record books nobody ever reads.</p></div>
              <div class="problem-card reveal reveal-delay-2"><div class="p-ico">📚</div><h3>Teacher overload</h3><p>Teachers spend too much time checking records — and too little time teaching.</p></div>
              <div class="problem-card reveal reveal-delay-3"><div class="p-ico">❓</div><h3>No proof of learning</h3><p>Students leave with no practical proof of what they actually learned.</p></div>
            </div>
          </div>
        </section>

        <!-- SOLUTION -->
        <section class="l-section solution-section" id="solution">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ The solution</span>
            <h2 class="l-title reveal">One Platform.<br/><span class="grad-text">Complete Practical Learning.</span></h2>
            <p class="l-sub reveal">AI wraps around the entire laboratory workflow — before, during, and after every lab.</p>
            <div class="workflow">
              <div class="step-card reveal">
                <span class="step-num">Step 1</span>
                <span class="step-phase">Before Lab</span>
                <h3>Knowledge Check</h3>
                <ul>
                  <li><span class="chk">✓</span><span>Teacher selects previous topics</span></li>
                  <li><span class="chk">✓</span><span>AI generates an MCQ quiz</span></li>
                  <li><span class="chk">✓</span><span>Students finish a 10–20 min assessment</span></li>
                  <li><span class="chk">✓</span><span>Teacher sees live scores</span></li>
                </ul>
              </div>
              <div class="step-card reveal reveal-delay-1">
                <span class="step-num">Step 2</span>
                <span class="step-phase">During Lab</span>
                <h3>Guided Understanding</h3>
                <ul>
                  <li><span class="chk">✓</span><span>Teacher pastes the experiment code</span></li>
                  <li><span class="chk">✓</span><span>AI splits it into logical blocks</span></li>
                  <li><span class="chk">✓</span><span>Each block gets explanation + questions</span></li>
                  <li><span class="chk">✓</span><span>Mini checkpoints — no blind continuing</span></li>
                </ul>
              </div>
              <div class="step-card reveal reveal-delay-2">
                <span class="step-num">Step 3</span>
                <span class="step-phase">After Lab</span>
                <h3>Proof &amp; Portfolio</h3>
                <ul>
                  <li><span class="chk">✓</span><span>Complete code + AI documentation</span></li>
                  <li><span class="chk">✓</span><span>Experiment summary &amp; reflection notes</span></li>
                  <li><span class="chk">✓</span><span>One-click GitHub push</span></li>
                  <li><span class="chk">✓</span><span>Learning analytics for every student</span></li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <!-- FEATURES -->
        <section class="l-section" id="features">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ Features</span>
            <h2 class="l-title reveal">Everything a Modern Lab Needs</h2>
            <p class="l-sub reveal">Eight core capabilities working together to transform the laboratory experience.</p>
            <div class="feature-grid">
              ${features.map((f, i) => `<div class="feature reveal reveal-delay-${i % 3}"><div class="icon">${f[0]}</div><h3>${esc(f[1])}</h3><p>${esc(f[2])}</p></div>`).join('')}
            </div>
          </div>
        </section>

        <!-- BENEFITS -->
        <section class="l-section" id="benefits">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ Benefits</span>
            <h2 class="l-title reveal">Worth It for <span class="grad-text">Everyone</span></h2>
            <p class="l-sub reveal">Students learn more, teachers do less admin, and colleges look better on paper.</p>
            <div class="benefits-grid">
              ${benefits.map((b, i) => `
                <div class="benefit-card reveal reveal-delay-${i % 3}">
                  <div class="b-ico">${b[0]}</div>
                  <h3>${esc(b[1])}</h3>
                  <div class="b-aud">Key outcomes</div>
                  <ul>${b[2].map((item) => `<li><span class="chk">✓</span><span>${esc(item)}</span></li>`).join('')}</ul>
                </div>`).join('')}
            </div>
          </div>
        </section>

        <!-- HOW IT WORKS -->
        <section class="l-section how-section" id="how">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ How it works</span>
            <h2 class="l-title reveal">From Lab Entry to <span class="grad-text">GitHub Portfolio</span></h2>
            <p class="l-sub reveal">Ten steps. Zero paperwork. Scroll through the complete journey.</p>
            <div class="timeline">
              ${timeline.map((t) => `<div class="tl-item reveal"><span class="tl-dot">${t[0]}</span><div class="tl-card"><h4>${esc(t[1])}</h4><p>${esc(t[2])}</p></div></div>`).join('')}
            </div>
          </div>
        </section>

        <!-- EXTRA FEATURES -->
        <section class="l-section" id="extras">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ Plus</span>
            <h2 class="l-title reveal">A Platform, <span class="grad-text">Not Just a Tool</span></h2>
            <p class="l-sub reveal">Gamified learning, dashboards, and integrations — everything students love and admins need.</p>
            <div class="extras-grid">
              ${extras.map((e, i) => `<div class="extra-chip reveal reveal-delay-${i % 3}"><span class="ex-ico">${e[0]}</span><span>${esc(e[1])}</span></div>`).join('')}
            </div>
          </div>
        </section>

        <!-- VISION -->
        <section class="l-section vision-section" id="vision">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ Future vision</span>
            <h2 class="l-title reveal">Beyond Digital <span class="grad-text">Records</span></h2>
            <p class="l-sub reveal">This platform is evolving into the operating system for practical education.</p>
            <div class="vision-grid">
              ${vision.map((v, i) => `<div class="vision-card reveal reveal-delay-${i % 3}"><div class="v-ico">${v[0]}</div><h4>${esc(v[1])}</h4><p>${esc(v[2])}</p></div>`).join('')}
            </div>
          </div>
        </section>

        <!-- TESTIMONIALS -->
        <section class="l-section" id="testimonials">
          <div class="l-wrap l-center">
            <span class="l-eyebrow reveal">✦ Testimonials</span>
            <h2 class="l-title reveal">Loved Across the <span class="grad-text">Campus</span></h2>
            <div class="testimonial-grid">
              ${testimonials.map((t, i) => `
                <div class="testimonial-card reveal reveal-delay-${i % 3}">
                  <div class="t-stars">★★★★★</div>
                  <div class="t-quote">“${esc(t[2])}”</div>
                  <div class="t-person">
                    <div class="t-avatar">${esc(t[0][0])}</div>
                    <div><div class="t-name">${esc(t[0])}</div><div class="t-role">${esc(t[1])}</div></div>
                  </div>
                </div>`).join('')}
            </div>
          </div>
        </section>

        <!-- FINAL CTA -->
        <section class="cta-section">
          <div class="l-wrap">
            <div class="cta-card reveal">
              <h2>Ready to Transform Practical Learning?</h2>
              <p>See how colleges are replacing record books with real, provable learning.</p>
              <div class="cta-actions">
                <a class="btn" href="#/auth">Book a Demo →</a>
                <a class="btn btn-white-ghost" href="mailto:hello@interviewiq.app">Contact Us</a>
              </div>
            </div>
          </div>
        </section>

        <!-- FOOTER -->
        <footer class="landing-footer">
          <div class="l-wrap">
            <div class="footer-grid">
              <div class="footer-brand">
                <a class="brand" href="#/"><span class="brand-mark">🎯</span><span class="brand-name">Interview<span class="brand-accent">IQ</span></span></a>
                <p>AI-powered practical learning for colleges — replacing handwritten records with understanding, assessment, and real GitHub portfolios.</p>
              </div>
              <div class="footer-col">
                <h5>Product</h5>
                <a href="#/" onclick="event.preventDefault();scrollToSection('features')">Features</a>
                <a href="#/" onclick="event.preventDefault();scrollToSection('solution')">How it works</a>
                <a href="#/auth">Pricing</a>
                <a href="#/" onclick="event.preventDefault();scrollToSection('testimonials')">FAQs</a>
              </div>
              <div class="footer-col">
                <h5>Company</h5>
                <a href="#/auth">About</a>
                <a href="#/auth">Contact</a>
                <a href="#/auth">Privacy</a>
                <a href="#/auth">Terms</a>
              </div>
              <div class="footer-col">
                <h5>Connect</h5>
                <div class="footer-social">
                  <a href="https://www.linkedin.com" target="_blank" rel="noopener" title="LinkedIn">in</a>
                  <a href="https://github.com" target="_blank" rel="noopener" title="GitHub">⌥</a>
                </div>
              </div>
            </div>
            <div class="footer-bottom">
              <span>© ${new Date().getFullYear()} InterviewIQ · AI Practical Learning Platform</span>
              <span>Made for colleges that care about real learning.</span>
            </div>
          </div>
        </footer>
      </div>`;

    bindReveals();
    animateCounters();
    window.scrollTo(0, 0);

    // Hydrate real stats + AI status without blocking first paint
    api('/health').catch(() => null).then((h) => {
      if (!h) return;
      [
        ['st-q', h.kb?.questions],
        ['st-t', h.kb?.topics],
        ['st-r', h.kb?.roles],
      ].forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && val != null) {
          el.dataset.count = val;
          animateCounters(el.parentElement);
        }
      });
      const badge = document.querySelector('.hero-badge');
      if (badge) badge.innerHTML = `<span class="pulse-dot"></span> ${esc(h.llm ? 'AI engine online' : 'Local AI engine')} · Built for colleges`;
    });
  }

  // ------------------------------------------------------------
  // AUTH
  // ------------------------------------------------------------
  function renderAuth() {
    app.innerHTML = `
      <section class="view auth-wrap">
        <div class="auth-card card">
          <div class="auth-head">
            <div class="auth-logo">🎯</div>
            <h1>Interview<span class="grad-text">IQ</span></h1>
            <p>AI mock interviews that coach you —<br/>or help you coach others.</p>
          </div>
          <div class="auth-tabs">
            <button class="auth-tab active" data-tab="login">Log in</button>
            <button class="auth-tab" data-tab="register">Create account</button>
          </div>
          <div class="role-doors" id="roleDoors" style="display:none;">
            <button type="button" class="role-door teacher-door" data-role="teacher">
              <span class="rd-icon">👩‍🏫</span>
              <span class="rd-txt"><span class="rd-title">I'm a teacher</span><span class="rd-sub">Build the question bank &amp; assign interviews</span></span>
            </button>
            <button type="button" class="role-door student-door active" data-role="student">
              <span class="rd-icon">🧑‍🎓</span>
              <span class="rd-txt"><span class="rd-title">I'm a student</span><span class="rd-sub">Take mock interviews &amp; track progress</span></span>
            </button>
          </div>
          <form id="authForm" autocomplete="on">
            <div class="field">
              <label>Username</label>
              <input class="input" id="authUser" name="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" placeholder="e.g. priya_sharma" required />
            </div>
            <div class="field">
              <label>Password</label>
              <input class="input" id="authPass" name="password" type="password" minlength="6" placeholder="••••••••" required />
            </div>
            <button class="btn auth-submit" id="authSubmit" type="submit">Log in →</button>
            <div class="auth-error" id="authError"></div>
          </form>
        </div>
      </section>`;

    let mode = 'login';
    let role = 'student';

    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        mode = tab.dataset.tab;
        document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('#roleDoors').style.display = mode === 'register' ? '' : 'none';
        $('#authSubmit').textContent = mode === 'login' ? 'Log in →' : 'Create account →';
      });
    });
    document.querySelectorAll('.role-door').forEach((door) => {
      door.addEventListener('click', () => {
        role = door.dataset.role;
        document.querySelectorAll('.role-door').forEach((d) => d.classList.toggle('active', d === door));
      });
    });

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#authSubmit');
      const err = $('#authError');
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = mode === 'login' ? 'Logging in…' : 'Creating account…';
      try {
        const body = { username: $('#authUser').value.trim(), password: $('#authPass').value };
        const res = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(mode === 'login' ? body : { ...body, role }) });
        state.user = res.user;
        applyRole();
        renderNav();
        location.hash = '#/home';
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = mode === 'login' ? 'Log in →' : 'Create account →';
      }
    });
  }

  // ------------------------------------------------------------
  // HOME (role-aware landing)
  // ------------------------------------------------------------
  async function renderHome() {
    if (isTeacher()) return renderTeacherHome();
    return renderStudentHome();
  }

  async function renderStudentHome() {
    const name = state.user ? `, ${esc(state.user.username)}` : '';
    app.innerHTML = `
      <section class="hero view">
        <span class="eyebrow">✦ Mock interview co-pilot</span>
        <h1>Welcome back${name} —<br/><span class="grad-text">your AI interviewer is ready</span></h1>
        <p>Upload a resume and a job description. The RAG engine builds a question bank for your exact role, an adaptive AI interviewer quizzes you, ML scores your answers, and reports track your improvement — plus any interviews your teacher assigns show up under <strong>My interviews</strong>.</p>
        <div class="hero-actions">
          <button class="btn" onclick="location.hash='#/setup'">🚀 Start an interview</button>
          <button class="btn btn-ghost" onclick="location.hash='#/mine'">📥 My interviews</button>
          <button class="btn btn-ghost" onclick="location.hash='#/history'">📈 History</button>
        </div>
      </section>
      <section class="feature-grid view" id="features">
        <div class="feature"><div class="icon">🧠</div><h3>RAG question bank</h3><p>Retrieves the most relevant questions for your role, skills, and target company from a curated knowledge base.</p></div>
        <div class="feature"><div class="icon">🤖</div><h3>Adaptive interviewer</h3><p>An AI co-pilot that asks questions, fires smart follow-ups, and adjusts difficulty to your answers.</p></div>
        <div class="feature"><div class="icon">📊</div><h3>ML answer scoring</h3><p>A classifier grades STAR structure, filler words, relevance, and quantified evidence — not just an LLM opinion.</p></div>
        <div class="feature"><div class="icon">🎤</div><h3>Voice answers</h3><p>Answer out loud using your browser's microphone — speech-to-text does the typing.</p></div>
        <div class="feature"><div class="icon">📋</div><h3>Post-interview report</h3><p>Strengths, gaps, and concrete resources — with multi-session tracking that charts your improvement.</p></div>
        <div class="feature"><div class="icon">🎓</div><h3>Teacher-assigned</h3><p>Pick up interviews your teacher created for you, right from your dashboard.</p></div>
      </section>
      <div class="home-stats view" id="home-stats">
        <div class="stat"><div class="num grad-text" id="st-q">–</div><div class="lbl">questions</div></div>
        <div class="stat"><div class="num grad-text" id="st-r">–</div><div class="lbl">roles</div></div>
        <div class="stat"><div class="num grad-text" id="st-t">–</div><div class="lbl">topics</div></div>
        <div class="stat"><div class="num grad-text" id="st-s">–</div><div class="lbl">my sessions</div></div>
      </div>`;
    const [h, mine] = await Promise.all([api('/health').catch(() => null), api('/sessions').catch(() => ({ sessions: [] }))]);
    if (h) {
      $('#st-q').textContent = h.kb.questions;
      $('#st-r').textContent = h.kb.roles;
      $('#st-t').textContent = h.kb.topics;
    }
    $('#st-s').textContent = mine.sessions.length;
  }

  async function renderTeacherHome() {
    app.innerHTML = `
      <section class="view">
        <div class="teacher-hero">
          <span class="eyebrow">✦ Teacher console</span>
          <h1 class="section-title">Coach your students to<br/><span class="grad-text">interview-ready</span></h1>
          <p class="section-sub">Shape the question bank your students are drilled on, then assign focused mock interviews and watch their scores land.</p>
        </div>
        <div class="t-stats">
          <div class="stat"><div class="num grad-text" id="tq">–</div><div class="lbl">questions in bank</div></div>
          <div class="stat"><div class="num grad-text" id="ts">–</div><div class="lbl">students</div></div>
          <div class="stat"><div class="num grad-text" id="tt">–</div><div class="lbl">sessions started</div></div>
        </div>
        <div class="t-cards">
          <button class="card t-card" onclick="location.hash='#/bank'">
            <span class="t-card-icon">📚</span>
            <span class="t-card-body"><span class="t-card-title">Manage question bank</span><span class="t-card-sub">Add, edit, and remove the questions used by every interview.</span></span>
            <span class="t-card-arrow">→</span>
          </button>
          <button class="card t-card" onclick="location.hash='#/assign'">
            <span class="t-card-icon">🎯</span>
            <span class="t-card-body"><span class="t-card-title">Assign an interview</span><span class="t-card-sub">Create a focused mock interview for any of your students.</span></span>
            <span class="t-card-arrow">→</span>
          </button>
        </div>
      </section>`;
    const [h, students, sessions] = await Promise.all([
      api('/health').catch(() => null),
      api('/teacher/students').catch(() => ({ students: [] })),
      api('/sessions').catch(() => ({ sessions: [] })),
    ]);
    $('#tq').textContent = h ? h.kb.questions : '–';
    $('#ts').textContent = students.students.length;
    $('#tt').textContent = sessions.sessions.length;
  }

  // ------------------------------------------------------------
  // SETUP (student)
  // ------------------------------------------------------------
  async function renderSetup() {
    await loadMeta();
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

    $('#roleSelect').insertAdjacentHTML('beforeend', state.meta.roles.filter((r) => r.id !== 'general').map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join(''));
    $('#companySelect').insertAdjacentHTML('beforeend', state.meta.companies.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join(''));

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
              <div class="ih-sub">${esc(session.profile.roleLabel || 'General')}${session.company ? ' · ' + esc(session.profile.companyLabel || session.company) : ''}${session.assignedBy ? ' · assigned by ' + esc(session.assignedByUsername || 'your teacher') : ''}</div>
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

    const apiStatus = await api('/health').catch(() => ({}));
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

    // Difficulty meter
    const diff = session.state?.difficulty || 2;
    $('#diffSegs').innerHTML = [1, 2, 3].map((i) => `<span class="diff-seg ${i <= diff ? 'on' : ''}"></span>`).join('');
    $('#diffLabel').textContent = ['', 'Warm-up', 'Steady', 'Stretch'][diff] || '';

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

    // improvement data: last 10 completed sessions for this owner (history is newest-first)
    const history = await api('/sessions').catch(() => ({ sessions: [] }));
    const completed = history.sessions
      .filter((s) => s.status === 'completed' && s.totalScore != null && (!session.ownerId || s.ownerId === session.ownerId))
      .slice(0, 10).reverse();

    app.innerHTML = `
      <section class="view">
        <div class="report-hero">
          <span class="eyebrow">📋 Post-interview report</span>
          <h2 class="section-title">${esc(session.profile.roleLabel || 'Interview')}${session.company ? ' at ' + esc(session.profile.companyLabel || '') : ''}</h2>
          <div class="muted" style="font-size:13.5px;">${fmtDate(session.completedAt || session.createdAt)} · ${answers.length} answers${session.assignedBy ? ' · assigned by ' + esc(session.assignedByUsername || 'teacher') : ''}</div>
          <div class="gauge-wrap" style="margin-top:26px;">
            <div class="gauge">
              <svg width="190" height="190" viewBox="0 0 190 190">
                <circle cx="95" cy="95" r="80" fill="none" style="stroke:var(--chart-track)" stroke-width="13"/>
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
      grid += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" style="stroke:var(--chart-track)"/>`;
      const lx = cx + (r + 20) * Math.cos(ang), ly = cy + (r + 20) * Math.sin(ang);
      grid += `<text x="${lx}" y="${ly}" style="fill:var(--text-faint)" font-size="10" text-anchor="middle" dominant-baseline="middle">${labels[i][1]}</text>`;
    });
    for (const ring of [0.33, 0.66, 1]) {
      grid += `<polygon points="${labels.map(([k], i) => { const ang = (Math.PI * 2 * i) / labels.length - Math.PI / 2; return `${cx + r * ring * Math.cos(ang)},${cy + r * ring * Math.sin(ang)}`; }).join(' ')}" fill="none" style="stroke:var(--chart-track)"/>`;
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
  // HISTORY (student)
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
                  <td>${fmtDate(s.createdAt)}</td>
                  <td>${esc(s.roleLabel || s.role || 'general')}${s.assignedBy ? ' <span class="pill" style="font-size:10px;">📥 assigned</span>' : ''}</td>
                  <td>${esc(s.companyLabel || s.company || '—')}</td>
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
  // MY INTERVIEWS (student — teacher-assigned)
  // ------------------------------------------------------------
  async function renderMine() {
    app.innerHTML = loading('Loading your assigned interviews…');
    const res = await api('/sessions').catch(() => ({ sessions: [] }));
    const assigned = res.sessions.filter((s) => s.assignedBy);

    if (!assigned.length) {
      app.innerHTML = `
        <section class="view empty-state">
          <div class="e-icon">📥</div>
          <h3>No assigned interviews yet</h3>
          <p>When your teacher assigns you a mock interview, it will show up here ready to take.</p>
          <button class="btn" onclick="location.hash='#/setup'">🎯 Start your own interview</button>
        </section>`;
      return;
    }

    app.innerHTML = `
      <section class="view">
        <h2 class="section-title">My interviews</h2>
        <p class="section-sub">Mock interviews your teacher created for you.</p>
        <div class="mine-grid">
          ${assigned.map((s) => `
            <div class="card mine-card" onclick="location.hash='#/${s.status === 'completed' ? 'report' : 'interview'}/${s.id}'">
              <div class="mc-top">
                <div class="mc-role">${esc(s.roleLabel || s.role || 'General')}</div>
                <span class="score-badge ${scoreClass(s.totalScore)}">${s.totalScore != null ? s.totalScore + '/100' : '—'}</span>
              </div>
              <div class="mc-company">${s.companyLabel ? '🏢 ' + esc(s.companyLabel) : '📋 General interview'}</div>
              <div class="mc-meta">${s.questionCount ?? '–'} questions · assigned by <strong>${esc(s.assignedByUsername || 'teacher')}</strong></div>
              <div class="mc-foot">
                <span class="pill">${s.status === 'completed' ? '✅ completed' : '⏳ in progress'}</span>
                <span class="mc-cta">${s.status === 'completed' ? 'View report →' : 'Continue →'}</span>
              </div>
            </div>`).join('')}
        </div>
      </section>`;
  }

  // ------------------------------------------------------------
  // QUESTION BANK (teacher)
  // ------------------------------------------------------------
  async function renderBank() {
    app.innerHTML = loading('Loading the question bank…');
    const data = await api('/questions').catch(() => null);
    if (!data) return;
    const roleName = Object.fromEntries(data.roles.map((r) => [r.id, r.label]));
    const topicName = Object.fromEntries(data.topics.map((t) => [t.id, t.label]));

    const draw = (list) => {
      $('#qList').innerHTML = list.length ? list.map((q) => `
        <div class="card q-card" data-id="${esc(q.id)}">
          <div class="qc-head">
            <div class="qc-text">${esc(q.text)}</div>
            <div class="qc-actions">
              <button class="icon-btn" data-act="edit" title="Edit">✏️</button>
              <button class="icon-btn" data-act="del" title="Delete">🗑️</button>
            </div>
          </div>
          <div class="qc-tags">
            ${(q.roles || []).map((r) => `<span class="pill role-pill">${esc(roleName[r] || r)}</span>`).join('')}
            ${(q.topics || []).map((t) => `<span class="pill">${esc(topicName[t] || t)}</span>`).join('')}
            <span class="pill diff-pill">${'●'.repeat(q.difficulty || 1)}${'○'.repeat(Math.max(0, 3 - (q.difficulty || 1)))}</span>
          </div>
          ${(q.idealPoints || []).length ? `<div class="qc-points">💡 ${(q.idealPoints || []).slice(0, 2).map((p) => esc(p)).join(' · ')}${(q.idealPoints || []).length > 2 ? ' …' : ''}</div>` : ''}
        </div>`).join('') : `<div class="empty-state"><div class="e-icon">🔍</div><h3>No questions match</h3><p>Try a different search or add a new question.</p></div>`;
    };

    app.innerHTML = `
      <section class="view">
        <div class="view-head">
          <div>
            <span class="eyebrow">✦ Teacher console</span>
            <h2 class="section-title">Question bank</h2>
            <p class="section-sub" id="bankCount">${data.questions.length} questions · powering every interview</p>
          </div>
          <button class="btn" id="addQBtn">＋ Add question</button>
        </div>
        <div class="bank-toolbar">
          <input class="input" id="qSearch" placeholder="Search questions…" />
          <select class="input bank-filter" id="qRoleFilter"><option value="">All roles</option>${data.roles.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select>
        </div>
        <div class="q-list" id="qList"></div>

        <div class="card q-form" id="qForm" hidden>
          <h3 id="qFormTitle">Add a question</h3>
          <div class="field">
            <label>Question text</label>
            <textarea class="textarea" id="qfText" placeholder="e.g. Walk me through a time you had to debug a production outage."></textarea>
          </div>
          <div class="two-col">
            <div class="field">
              <label>Roles</label>
              <div class="chip-row" id="qfRoles"></div>
            </div>
            <div class="field">
              <label>Topics</label>
              <div class="chip-row" id="qfTopics"></div>
            </div>
          </div>
          <div class="two-col">
            <div class="field">
              <label>Difficulty</label>
              <select class="input" id="qfDiff">
                <option value="1">1 — Warm-up</option>
                <option value="2" selected>2 — Core</option>
                <option value="3">3 — Stretch</option>
              </select>
            </div>
            <div class="field">
              <label>&nbsp;</label>
              <button class="btn btn-ghost" id="qfCancel" type="button">Cancel</button>
            </div>
          </div>
          <div class="field">
            <label>Ideal points <span class="hint">one per line — what a strong answer includes</span></label>
            <textarea class="textarea qf-short" id="qfIdeal" placeholder="1-minute structured intro with numbers&#10;Mention 2-3 achievements, not just duties"></textarea>
          </div>
          <div class="field">
            <label>Follow-ups <span class="hint">one per line — probes for weak answers</span></label>
            <textarea class="textarea qf-short" id="qfFollow" placeholder="Walk me through the most relevant project in more detail."></textarea>
          </div>
          <div class="setup-actions">
            <button class="btn" id="qfSave">Save question</button>
            <span class="faint" id="qfStatus"></span>
          </div>
        </div>
      </section>`;

    draw(data.questions);

    let editingId = null;

    // Chip builder for roles/topics
    const chipRow = (list, sel, wrapId) => {
      $(wrapId).innerHTML = list.map(([id, label]) =>
        `<label class="chip ${sel.includes(id) ? 'on' : ''}"><input type="checkbox" value="${esc(id)}" ${sel.includes(id) ? 'checked' : ''} hidden /><span>${esc(label)}</span></label>`
      ).join('');
      $(wrapId).querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => cb.closest('.chip').classList.toggle('on', cb.checked)));
    };
    const selRoles = () => [...$('#qfRoles').querySelectorAll('input:checked')].map((c) => c.value);
    const selTopics = () => [...$('#qfTopics').querySelectorAll('input:checked')].map((c) => c.value);
    const newLines = (id) => $('#qf' + id).value.split('\n').map((s) => s.trim()).filter(Boolean);

    const openForm = (q) => {
      editingId = q ? q.id : null;
      $('#qForm').hidden = false;
      $('#qFormTitle').textContent = q ? 'Edit question' : 'Add a question';
      $('#qfText').value = q ? q.text : '';
      $('#qfDiff').value = String(q ? q.difficulty : 2);
      $('#qfIdeal').value = q ? (q.idealPoints || []).join('\n') : '';
      $('#qfFollow').value = q ? (q.followUps || []).join('\n') : '';
      chipRow(data.roles.map((r) => [r.id, r.label]), q ? q.roles || [] : [], '#qfRoles');
      chipRow(data.topics.map((t) => [t.id, t.label]), q ? q.topics || [] : [], '#qfTopics');
      $('#qfStatus').textContent = '';
      $('#qForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    $('#addQBtn').addEventListener('click', () => openForm(null));
    $('#qfCancel').addEventListener('click', () => { $('#qForm').hidden = true; editingId = null; });

    $('#qfSave').addEventListener('click', async () => {
      const text = $('#qfText').value.trim();
      if (!text) return toast('Add the question text first.');
      const btn = $('#qfSave');
      const body = {
        text,
        roles: selRoles(),
        topics: selTopics(),
        difficulty: Number($('#qfDiff').value),
        idealPoints: newLines('Ideal'),
        followUps: newLines('Follow'),
      };
      btn.disabled = true;
      $('#qfStatus').textContent = 'Saving…';
      try {
        if (editingId) {
          await api(`/questions/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
          toast('Question updated.');
        } else {
          await api('/questions', { method: 'POST', body: JSON.stringify(body) });
          toast('Question added to the bank.');
        }
        const fresh = await api('/questions');
        data.questions = fresh.questions;
        draw(data.questions);
        $('#bankCount').textContent = `${data.questions.length} questions · powering every interview`;
        $('#qForm').hidden = true;
        editingId = null;
      } catch (err) {
        toast('⚠️ ' + err.message, 5000);
      } finally {
        btn.disabled = false;
        $('#qfStatus').textContent = '';
      }
    });

    // Search + role filter
    const applyFilters = () => {
      const q = $('#qSearch').value.trim().toLowerCase();
      const role = $('#qRoleFilter').value;
      const list = data.questions.filter((x) =>
        (!role || (x.roles || []).includes(role)) &&
        (!q || x.text.toLowerCase().includes(q) || (x.idealPoints || []).some((p) => p.toLowerCase().includes(q)))
      );
      draw(list);
    };
    $('#qSearch').addEventListener('input', applyFilters);
    $('#qRoleFilter').addEventListener('change', applyFilters);

    // Delegated edit/delete
    $('#qList').addEventListener('click', async (e) => {
      const btn = e.target.closest('.icon-btn');
      if (!btn) return;
      const card = btn.closest('.q-card');
      const id = card.dataset.id;
      if (btn.dataset.act === 'edit') {
        openForm(data.questions.find((x) => x.id === id));
      } else if (btn.dataset.act === 'del' && confirm('Delete this question from the bank?')) {
        try {
          await api('/questions/' + id, { method: 'DELETE' });
          const fresh = await api('/questions');
          data.questions = fresh.questions;
          draw(data.questions);
          $('#bankCount').textContent = `${data.questions.length} questions · powering every interview`;
          toast('Question deleted.');
        } catch (err) {
          toast('⚠️ ' + err.message, 5000);
        }
      }
    });
  }

  // ------------------------------------------------------------
  // ASSIGN (teacher)
  // ------------------------------------------------------------
  async function renderAssign() {
    await loadMeta();
    app.innerHTML = loading('Loading your students…');
    const [studentsRes, sessionsRes] = await Promise.all([
      api('/teacher/students').catch(() => ({ students: [] })),
      api('/sessions').catch(() => ({ sessions: [] })),
    ]);
    const students = studentsRes.students;
    const recent = sessionsRes.sessions.filter((s) => s.assignedBy).slice(0, 6);

    app.innerHTML = `
      <section class="view">
        <div class="view-head">
          <div>
            <span class="eyebrow">✦ Teacher console</span>
            <h2 class="section-title">Assign an interview</h2>
            <p class="section-sub">Create a focused mock interview for a student — it appears instantly in their <strong>My interviews</strong>.</p>
          </div>
        </div>
        <div class="assign-grid">
          <div class="card assign-form">
            <h3>New assignment</h3>
            <div class="field">
              <label>Student</label>
              ${students.length
                ? `<select class="input" id="asStudent"><option value="">Pick a student…</option>${students.map((s) => `<option value="${s.id}">${esc(s.username)}${s.sessionCount ? ` · ${s.sessionCount} session(s)` : ''}</option>`).join('')}</select>`
                : `<div class="muted" style="font-size:13px;line-height:1.6;">No students yet. Ask a student to create an account on the sign-up screen — they'll appear here automatically.</div>`}
            </div>
            <div class="two-col">
              <div class="field">
                <label>Role</label>
                <select class="input" id="asRole"><option value="">✨ Auto-detect</option>${state.meta.roles.filter((r) => r.id !== 'general').map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Company</label>
                <select class="input" id="asCompany"><option value="">None</option>${state.meta.companies.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select>
              </div>
            </div>
            <div class="field">
              <label>Number of questions</label>
              <div class="range-row">
                <input type="range" id="asCount" min="3" max="12" value="6" />
                <span class="range-val" id="asCountVal">6</span>
              </div>
            </div>
            <button class="btn" id="asGo" ${students.length ? '' : 'disabled'}>📤 Assign interview</button>
            <span class="faint" id="asStatus" style="font-size:13px;margin-left:10px;"></span>
          </div>
          <div class="card assign-recent">
            <h3>Recent assignments</h3>
            ${recent.length
              ? recent.map((s) => `
                <div class="assign-item" onclick="location.hash='#/report/${s.id}'">
                  <div class="ai-top"><span class="ai-student">🎓 ${esc(s.ownerUsername || 'student')}</span><span class="score-badge ${scoreClass(s.totalScore)}">${s.totalScore != null ? s.totalScore + '/100' : '—'}</span></div>
                  <div class="ai-role">${esc(s.roleLabel || s.role || 'General')}${s.companyLabel ? ' · ' + esc(s.companyLabel) : ''}</div>
                  <div class="ai-meta">${fmtDate(s.createdAt)} · ${s.questionCount ?? '–'} questions · ${s.status === 'completed' ? '✅ completed' : '⏳ in progress'}</div>
                </div>`).join('')
              : '<div class="muted" style="font-size:13px;line-height:1.6;">Nothing assigned yet — your assignments will appear here so you can check scores.</div>'}
          </div>
        </div>
      </section>`;

    $('#asCount').addEventListener('input', (e) => { $('#asCountVal').textContent = e.target.value; });

    $('#asGo').addEventListener('click', async () => {
      const studentId = $('#asStudent').value;
      if (!studentId) return toast('Pick a student to assign this interview to.');
      const btn = $('#asGo');
      btn.disabled = true;
      $('#asStatus').textContent = 'Creating interview…';
      try {
        const res = await api('/teacher/assign', {
          method: 'POST',
          body: JSON.stringify({
            studentId,
            role: $('#asRole').value || undefined,
            company: $('#asCompany').value || undefined,
            questionCount: Number($('#asCount').value),
          }),
        });
        toast(`Interview assigned to ${res.student.username}.`);
        renderAssign(); // refresh the recent-assignments list
      } catch (err) {
        toast('⚠️ ' + err.message, 5000);
      } finally {
        btn.disabled = false;
        $('#asStatus').textContent = '';
      }
    });
  }

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------
  (async function boot() {
    initTheme();
    setupBurger();
    try {
      const me = await api('/auth/me');
      state.user = me.user;
    } catch {
      state.user = null;
    }
    applyRole();
    renderNav();
    if (!location.hash || location.hash === '#/') {
      location.hash = state.user ? '#/home' : '#/';
    }
    navigate();
  })();
})();
