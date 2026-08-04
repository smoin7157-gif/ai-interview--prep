'use strict';
/* End-to-end smoke test for the AI Interview Prep API.
   Run with the server up:  node tests/smoke.js   */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let cookie = '';

async function j(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const token = setCookie.split(';')[0];
    if (token.includes('iq_token=')) cookie = token;
  }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const rnd = Date.now().toString(36).slice(-6);
const STUDENT = `stu_${rnd}`;
const TEACHER = `tch_${rnd}`;
const PASS = 'secret123';

(async () => {
  // 1. Health (public)
  const health = await j('/api/health');
  console.log('✓ health:', JSON.stringify(health).slice(0, 120));

  // 2. Auth: me starts logged out
  const me0 = await j('/api/auth/me');
  if (me0.user) throw new Error('Expected logged-out /auth/me');
  console.log('✓ /auth/me (logged out)');

  // 3. Register a student + teacher
  await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: STUDENT, password: PASS, role: 'student' }) });
  const meS = await j('/api/auth/me');
  if (!meS.user || meS.user.role !== 'student') throw new Error('Student registration/login failed');
  console.log('✓ registered + logged in as student:', meS.user.username);

  // 4. Unauthenticated session access is blocked
  cookie = '';
  let blocked = false;
  try { await j('/api/sessions'); } catch (e) { blocked = /log in/i.test(e.message); }
  if (!blocked) throw new Error('Expected 401 for unauthenticated /api/sessions');
  console.log('✓ unauthenticated access blocked');

  // 5. Student self-serve interview flow
  await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: STUDENT, password: PASS }) });
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
  if (!rep.report || rep.stats.avg <= 0) throw new Error('Report missing or empty');

  const hist = await j('/api/sessions');
  if (!hist.sessions.some((x) => x.id === s.sessionId)) throw new Error('Session missing from own history');
  console.log('✓ history:', hist.sessions.length, 'session(s) scoped to student');

  // 6. Teacher registers, sees the student, assigns an interview
  await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: TEACHER, password: PASS, role: 'teacher' }) });
  const meT = await j('/api/auth/me');
  if (meT.user.role !== 'teacher') throw new Error('Teacher registration failed');
  console.log('✓ registered + logged in as teacher:', meT.user.username);

  const students = await j('/api/teacher/students');
  const student = students.students.find((u) => u.username === STUDENT);
  if (!student) throw new Error('Teacher cannot see the student roster');
  console.log('✓ teacher roster:', students.students.map((u) => u.username).join(','));

  const asg = await j('/api/teacher/assign', {
    method: 'POST',
    body: JSON.stringify({ studentId: student.id, role: 'frontend', company: 'google', questionCount: 3 }),
  });
  console.log('✓ assigned interview to', asg.student.username, '->', asg.sessionId, '| role:', asg.profile.role);

  // 7. Teacher sees all sessions (incl. the student's own + assigned)
  const allSessions = await j('/api/sessions');
  if (allSessions.sessions.length < 2) throw new Error('Teacher should see all sessions');
  console.log('✓ teacher sees all sessions:', allSessions.sessions.length);

  // 8. Student sees the assigned interview; ownership is enforced
  await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: STUDENT, password: PASS }) });
  const mine = await j('/api/sessions');
  const assigned = mine.sessions.find((x) => x.id === asg.sessionId);
  if (!assigned || !assigned.assignedBy) throw new Error('Student cannot see the assigned interview');
  console.log('✓ student sees assigned interview:', assigned.roleLabel, '| assigned by', assigned.assignedByUsername);

  // Teacher's own sessions should not leak into the student's view
  const teacherOwn = (await j('/api/sessions')).sessions;
  if (teacherOwn.some((x) => x.ownerId && x.ownerId !== student.id && x.ownerId !== meS.user.id)) {
    throw new Error('Foreign sessions leaked into student view');
  }
  console.log('✓ ownership scoping holds');

  // 9. Question bank CRUD (teacher only; student must be blocked)
  await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: TEACHER, password: PASS }) });
  const bank = await j('/api/questions');
  const before = bank.questions.length;
  const q = await j('/api/questions', {
    method: 'POST',
    body: JSON.stringify({ text: 'Smoke-test question: describe a time you led a difficult conversation.', roles: ['general'], topics: ['behavioral'], difficulty: 2, idealPoints: ['Concrete example'], followUps: ['What was the outcome?'] }),
  });
  await j(`/api/questions/${q.question.id}`, { method: 'PUT', body: JSON.stringify({ text: q.question.text + ' (edited)' }) });
  await j(`/api/questions/${q.question.id}`, { method: 'DELETE' });
  const after = (await j('/api/questions')).questions.length;
  if (after !== before) throw new Error('Question bank CRUD left the bank in a different state');
  console.log('✓ question bank CRUD (add/edit/delete) round-trips cleanly');

  // Student must be blocked from the teacher endpoints
  await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: STUDENT, password: PASS }) });
  let forbidden = false;
  try { await j('/api/questions'); } catch (e) { forbidden = /not available/i.test(e.message); }
  if (!forbidden) throw new Error('Expected student to be blocked from /api/questions');
  console.log('✓ role guard blocks students from teacher endpoints');

  console.log('\n✅ SMOKE TEST PASSED');
})().catch((e) => {
  console.error('\n❌ SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
