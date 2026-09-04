import assert from 'node:assert/strict';
const base = 'http://web';
assert.equal((await fetch('http://api:3000/health')).status, 200);
const html = await (await fetch(base)).text();
assert.ok(html.includes('id="root"'), 'Frontend HTML should load');
assert.equal((await fetch(base + '/api/session')).status, 401);
assert.equal((await fetch(base + '/internal/jobs/test/next')).status, 404);
const login = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToyotaPO' },
  body: JSON.stringify({ username: process.env.PILOT_USERNAME || 'pilot', password: process.env.PILOT_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.equal((await fetch(base + '/api/session', { headers: { cookie } })).status, 200);
console.log('Production API, frontend, proxy, and login smoke checks passed.');
