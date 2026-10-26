// Browser tests for trial/index.html using the pre-installed Playwright Chromium.
// Run: node trial/tests/trial.test.cjs
// The page is opened from disk, so there is no `window.claude`: this exercises the
// deterministic fallback path, triage, conflict gating, booking and handover.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  const fresh = async () => {
    await page.goto(FILE);
    await page.evaluate(() => localStorage.clear());
    await page.goto(FILE);
    await page.waitForFunction(() => document.getElementById('mode').dataset.mode === 'fallback');
  };
  const say = async text => {
    await page.fill('#clientInput', text);
    await page.click('#sendBtn');
    await page.waitForFunction(() => !document.getElementById('sendBtn').disabled || document.getElementById('clientInput').disabled);
  };
  const S = () => page.evaluate(() => window.__trial.state());
  const lastAi = async () => (await S()).messages.filter(m => m.who === 'ai').pop().text;

  console.log('Pure functions');
  await fresh();
  await test('triage: abuse is critical and fixed', async () => {
    const r = await page.evaluate(() => window.__trial.triage('My husband hit me last night'));
    assert(r.some(h => h.type === 'danger' && h.fixed));
  });
  await test('triage: non-molestation order flagged', async () => {
    const r = await page.evaluate(() => window.__trial.triage('I think I need a non-molestation order'));
    assert(r.some(h => h.type === 'protective_order'));
  });
  await test('triage: abduction flagged', async () => {
    const r = await page.evaluate(() => window.__trial.triage("He won't return the children after the weekend"));
    assert(r.some(h => h.type === 'safeguarding'));
  });
  await test('triage: imminent hearing, deadline, eviction are high but not fixed', async () => {
    const r = await page.evaluate(() => [
      window.__trial.triage('My court hearing is tomorrow'),
      window.__trial.triage('I have to respond to the application within 14 days'),
      window.__trial.triage('The landlord says he will evict me')]);
    assert(r[0].some(h => h.type === 'imminent_hearing' && !h.fixed));
    assert(r[1].some(h => h.type === 'deadline' && !h.fixed));
    assert(r[2].some(h => h.type === 'eviction' && !h.fixed));
  });
  await test('triage: ordinary divorce enquiry raises no flags', async () => {
    const r = await page.evaluate(() => window.__trial.triage('I want to get divorced, we separated last year'));
    assert.strictEqual(r.length, 0);
  });
  await test('estimate: financial agreed £2,700–£6,000 + VAT, n=61', async () => {
    const e = await page.evaluate(() => window.__trial.indicativeEstimate('financial_agreed'));
    assert.strictEqual(e.typical_cost, '£2,700–£6,000 + VAT'); assert.strictEqual(e.sample_size, 61);
  });
  await test('estimate: contested £10,500–£27,000; children £3,600–£12,000', async () => {
    const [a, b] = await page.evaluate(() => [window.__trial.indicativeEstimate('financial_contested'), window.__trial.indicativeEstimate('children')]);
    assert.strictEqual(a.typical_cost, '£10,500–£27,000 + VAT'); assert.strictEqual(b.typical_cost, '£3,600–£12,000 + VAT');
  });
  await test('estimate: insufficient sample (n=9) gives no figures', async () => {
    const e = await page.evaluate(() => window.__trial.indicativeEstimate('cohabitation_property'));
    assert.strictEqual(e.figures, null); assert.strictEqual(e.typical_cost, undefined); assert(/non-firm-specific/.test(e.note));
  });
  await test('schema validation rejects unknown fields and bad enums', async () => {
    const r = await page.evaluate(() => {
      const out = [];
      try { window.__trial.runTool('get_indicative_estimate', { matter_type: 'divorce', ignore_rules: true }, 't'); out.push('accepted'); } catch (e) { out.push(e.message); }
      try { window.__trial.runTool('get_approved_legal_guidance', { topic: 'tax' }, 't'); out.push('accepted'); } catch (e) { out.push(e.message); }
      return out;
    });
    assert(/unknown field/.test(r[0])); assert(/must be one of/.test(r[1]));
  });
  await test('guidance: unknown topic returns found:false', async () => {
    const r = await page.evaluate(() => window.__trial.runTool('get_approved_legal_guidance', { topic: 'other' }, 't'));
    assert.strictEqual(r.found, false);
  });
  await test('output guard blocks "has joined" and booking claims', async () => {
    const r = await page.evaluate(() => [window.__trial.guardOutput('Great news, a solicitor has joined.'), window.__trial.guardOutput("I've booked you in for Tuesday.")]);
    assert(!/joined/.test(r[0])); assert(!/booked you/.test(r[1]));
  });
  await test('handover machine: Closed has no exits', async () => {
    const n = await page.evaluate(() => window.__trial.HANDOVER_NEXT['Closed'].length); assert.strictEqual(n, 0);
  });

  console.log('Client flow (fallback mode)');
  await fresh();
  await test('greeting says AI, not a solicitor; fallback notice shown', async () => {
    const s = await S();
    assert(/not a solicitor/.test(s.messages.find(m => m.who === 'ai').text));
    assert(s.messages.some(m => m.fallbackNotice));
  });
  await test('divorce enquiry: empathy first, fixed fee mention, asks name', async () => {
    await say('My wife and I have separated and I want a divorce');
    const t = await lastAi();
    assert(/sorry/i.test(t)); assert(/fixed fee/.test(t)); assert(/full name/.test(t));
    assert(t.split(/\s+/).length <= 110, 'over 110 words: ' + t.split(/\s+/).length);
    assert((t.match(/\?/g) || []).length <= 2);
  });
  await test('fee question returns indicative divorce figure with disclaimers', async () => {
    await say('How much will it cost?');
    const t = await lastAi(); assert(/£1,500 \+ VAT/.test(t)); assert(/not a quotation/.test(t));
  });
  await test('name, then other party; clean names → Pending review, slots offered', async () => {
    await say('Alex Taylor');
    await say('Sam Taylor');
    const s = await S();
    assert.strictEqual(s.conflict.status, 'Pending review');
    assert(/further internal checks/.test(await lastAi()));
    assert.strictEqual(await page.locator('.slot').count(), 6);
  });
  await test('AI cannot book: no booking until Confirm is clicked', async () => {
    assert.strictEqual(Object.keys((await S()).bookings).length, 0);
  });
  await test('double Confirm creates exactly one booking (idempotent)', async () => {
    await page.locator('.slot').first().click();
    await page.evaluate(() => { const b = document.getElementById('confirmBtn'); b.click(); b.click(); });
    const s = await S();
    assert.strictEqual(Object.keys(s.bookings).length, 1);
    assert(/Provisional/.test(Object.values(s.bookings)[0].status));
    assert(s.audit.some(a => a.event === 'Duplicate booking request suppressed'));
    assert(s.messages.some(m => m.sim && /email/i.test(m.text)));
  });
  await test('staff view shows no conflict details to client', async () => {
    const s = await S();
    assert(!s.messages.filter(m => m.who !== 'staff').some(m => /conflict/i.test(m.text)));
  });

  await fresh();
  await test('availability recheck: slot taken in Outlook before Confirm is refused', async () => {
    await say('I need help sorting out the house and pension, we have agreed most of it');
    await say('Chris Moore'); await say('Pat Moore');
    await page.locator('.slot').first().click();
    await page.evaluate(() => document.getElementById('simTake').click());
    await page.click('#confirmBtn');
    const s = await S();
    assert.strictEqual(Object.keys(s.bookings).length, 0);
    assert(s.audit.some(a => a.event === 'Availability recheck failed'));
  });

  await fresh();
  await test('conflict fixture "J. Doe" → Potential conflict, booking blocked, neutral wording', async () => {
    await say('I need advice about arrangements for my children');
    await say('Morgan Lee'); await say('J. Doe');
    const s = await S();
    assert.strictEqual(s.conflict.status, 'Potential conflict');
    assert.strictEqual(await page.locator('.slot').count(), 0);
    assert(!/conflict/i.test(await lastAi()));
    assert(/further internal checks/.test(s.messages.filter(m => m.who === 'ai').slice(-1)[0].text));
  });
  await test('confirmBooking refuses while Potential conflict even if forced', async () => {
    const r = await page.evaluate(() => {
      const s = window.__trial.state();
      s.slots = [{ id: 'x', start: new Date(Date.now() + 864e5).toISOString(), minutes: 45, with: 'A' }];
      return window.__trial.confirmBooking('x');
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(Object.keys((await S()).bookings).length, 0);
  });
  await test('only staff can clear: Cleared by authorised staff sets status', async () => {
    await page.click('#tabBtnStaff');
    await page.getByRole('button', { name: 'Cleared by authorised staff' }).click();
    assert.strictEqual((await S()).conflict.status, 'Cleared by authorised staff');
    await page.click('#tabBtnClient');
  });

  await fresh();
  await test('safety: abuse → fixed message with 999 and helpline, handover requested, model skipped', async () => {
    await say("I'm scared, my partner hit me and I'm not safe at home");
    const s = await S();
    const m = s.messages.filter(x => x.who === 'ai').pop();
    assert(m.safety); assert(/999/.test(m.text)); assert(/0808 2000 247/.test(m.text));
    assert.strictEqual(s.handover, 'Waiting for staff');
    assert(s.audit.some(a => /model skipped/.test(a.event)));
    assert(!s.messages.some(x => /has joined/.test(x.text)), 'must not say joined before accept');
  });
  await test('safety hold: next message gets no model reply', async () => {
    await say('Please help');
    const s = await S(); assert(s.audit.some(a => a.event === 'Safety hold: model skipped'));
  });
  await test('staff accept → "joined" message; AI silent while Human active', async () => {
    await page.click('#tabBtnStaff');
    await page.getByRole('button', { name: 'Accept conversation' }).click();
    await page.click('#tabBtnClient');
    let s = await S();
    assert.strictEqual(s.handover, 'Human active');
    assert(s.messages.some(x => /has joined/.test(x.text)));
    const aiBefore = s.messages.filter(x => x.who === 'ai').length;
    await say('Thank you');
    s = await S(); assert.strictEqual(s.messages.filter(x => x.who === 'ai').length, aiBefore);
  });
  await test('internal notes never appear in client chat', async () => {
    await page.click('#tabBtnStaff');
    await page.fill('#staffNote', 'SECRET NOTE call police liaison');
    await page.click('#noteSave');
    await page.fill('#staffReply', 'Hello, I am here to help.');
    await page.click('#staffSend');
    await page.click('#tabBtnClient');
    const clientText = await page.locator('#clientLog').innerText();
    assert(!/SECRET NOTE/.test(clientText)); assert(/I am here to help/.test(clientText));
  });
  await test('return to AI, then close disables input', async () => {
    await page.click('#tabBtnStaff');
    await page.getByRole('button', { name: 'Return to AI' }).click();
    await page.getByRole('button', { name: 'Close conversation' }).click();
    assert.strictEqual((await S()).handover, 'Closed');
    assert(await page.locator('#clientInput').isDisabled());
  });
  await test('audit log records handover transitions', async () => {
    const s = await S();
    for (const t of ['AI active → Waiting for staff', 'Waiting for staff → Human active', 'Human active → Returned to AI', 'Returned to AI → Closed'])
      assert(s.audit.some(a => a.event === 'Handover state' && a.detail.startsWith(t)), 'missing ' + t);
  });
  await test('reset gives a fresh conversation', async () => {
    await page.click('#resetBtn'); await page.click('#resetBtn');
    const s = await S(); assert.strictEqual(s.handover, 'AI active'); assert.strictEqual(s.messages.filter(m => m.who === 'client').length, 0);
  });

  await fresh();
  await test('suppression: AI reply arriving after staff take over is not shown', async () => {
    // A fake model that ignores abort and replies late, after staff have taken over.
    await page.evaluate(() => {
      window.__trial.useFakeSample(() => new Promise(res => { window.__release = () => res({ text: 'LATE AI REPLY', truncated: false }); }));
    });
    await page.fill('#clientInput', 'I need help with a divorce');
    await page.click('#sendBtn');
    await page.waitForFunction(() => typeof window.__release === 'function');
    await page.evaluate(() => window.__trial.staffTransition('Human active'));
    await page.evaluate(() => window.__release());
    await page.waitForFunction(() => window.__trial.state().audit.some(a => a.event === 'AI reply suppressed' || a.event === 'AI call cancelled'));
    const clientText = await page.locator('#clientLog').innerText();
    assert(!/LATE AI REPLY/.test(clientText), 'late reply leaked to client');
    const s = await S();
    assert(s.audit.some(a => a.event === 'AI reply suppressed'));
  });

  await test('phone width: no horizontal page scroll', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await fresh();
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
    await page.click('#tabBtnStaff');
    const w2 = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert(w2[0] <= w2[1], `staff scrollWidth ${w2[0]} > ${w2[1]}`);
  });

  await test('no page errors', async () => { assert.deepStrictEqual(errors, []); });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
