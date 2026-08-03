'use strict';
/* End-to-end smoke test for the AI Interview Prep API.
   Run with the server up:  node tests/smoke.js   */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  const health = await j('/api/health');
  console.log('✓ health:', JSON.stringify(health).slice(0, 120));

  const jd = 'Software Engineer - Full Stack (Node.js, React, PostgreSQL). We need a software engineer experienced in distributed systems, REST APIs, microservices, databases, and system design. AWS preferred.';
  const resume = 'Software engineer with 4 years building scalable REST APIs and microservices in Node.js and React. Improved API p95 latency by 40% with caching and indexing. Led a team of 3. Worked on AWS.';

  const s = await j('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ jd, resumeText: resume, questionCount: 3 }),
  });
  console.log('✓ session', s.sessionId, '| role:', s.profile.role, '| company:', s.profile.company, '| topics:', s.profile.topics.join(','));
  if (s.profile.role !== 'software-engineer') throw new Error('Role inference failed');
  if (!s.opening || !s.opening.text) throw new Error('No opening question');
  console.log('✓ opening:', s.opening.text.slice(0, 90));

  // Weak answer -> expect scoring + follow-up
  const weak = 'I did some work on that once. It was fine, you know, we just handled it basically.';
  const r1 = await j(`/api/sessions/${s.sessionId}/answer`, { method: 'POST', body: JSON.stringify({ answer: weak }) });
  console.log('✓ answer#1 ->', r1.type, '| score:', r1.score, '| criteria:', JSON.stringify(r1.criteria));
  if (r1.score == null) throw new Error('No score returned');
  if (r1.type === 'followup') console.log('✓ follow-up:', r1.followUp.text.slice(0, 90));

  const strong = 'In my previous role at a fintech startup, I was responsible for the payments API. The task was to cut timeouts during peak traffic. I implemented connection pooling, added Redis caching for idempotency checks, and indexed the slow queries. As a result, p95 latency dropped 40% and we absorbed 3x peak traffic without incidents.';
  let prev = r1;
  for (let i = 0; i < 6; i++) {
    prev = await j(`/api/sessions/${s.sessionId}/answer`, { method: 'POST', body: JSON.stringify({ answer: strong }) });
    if (prev.type === 'done') break;
  }
  console.log('✓ final ->', prev.type, '| progress:', prev.progress);
  if (prev.type !== 'done') throw new Error('Interview never completed');

  const rep = await j(`/api/sessions/${s.sessionId}/complete`, { method: 'POST' });
  console.log('✓ report avg:', rep.stats.avg, '| improvement:', rep.improvementDelta, '| strengths:', (rep.report.strengths || []).map((x) => x.label).join(','));
  console.log('✓ summary:', (rep.report.summary || '').slice(0, 140));
  if (!rep.report || rep.stats.avg <= 0) throw new Error('Report missing or empty');

  const detail = await j(`/api/sessions/${s.sessionId}`);
  console.log('✓ turns:', detail.turns.length, '| status:', detail.session.status);

  const hist = await j('/api/sessions');
  console.log('✓ history:', hist.sessions.length, 'session(s)');

  console.log('\n✅ SMOKE TEST PASSED');
})().catch((e) => {
  console.error('\n❌ SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
