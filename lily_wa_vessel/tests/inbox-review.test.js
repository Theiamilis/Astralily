const test = require('node:test');
const assert = require('node:assert/strict');
const { createInboxReview } = require('../inbox-review');
function fixture(overrides = {}) {
    const items = [{id:'one', chatId:'123@c.us', originalMessage:'Can you check this?', priority:'high'}];
    const sent = []; let saves = 0;
    const review = createInboxReview({items, allowed:()=>true, save:()=>{saves++;},
        generate:async()=>({reply:'I will pass your request along.'}), send:async(...args)=>sent.push(args), handoff:()=>{}, ...overrides});
    return {items, review, sent, saves:()=>saves};
}
test('drafts never send; approved edited reply sends once', async () => {
    const f = fixture(); const d = await f.review.draft('one'); assert.equal(f.sent.length,0);
    await f.review.approve('one',d.revision,'Edited reply');
    assert.deepEqual(f.sent,[['123@c.us','Edited reply']]);
    await assert.rejects(f.review.approve('one',d.revision,'Again')); assert.equal(f.sent.length,1);
});
test('a new message invalidates an old draft', async () => {
    const f = fixture(); const d = await f.review.draft('one');
    f.items.unshift({id:'two',chatId:'123@c.us',originalMessage:'New context'});
    await assert.rejects(f.review.approve('one',d.revision,'Reply')); assert.equal(f.sent.length,0);
});
test('uncertain send cannot be retried or redrafted', async () => {
    const f = fixture({send:async()=>{throw Error('timeout');}}); const d = await f.review.draft('one');
    await assert.rejects(f.review.approve('one',d.revision,'Reply'));
    assert.equal(f.items[0].review.status,'uncertain'); await assert.rejects(f.review.draft('one'));
});
test('manual owner reply invalidates a draft still generating', async () => {
    let finish; const f = fixture({generate:()=>new Promise(resolve=>{finish=resolve;})});
    const pending = f.review.draft('one'); f.review.ownerReplied('123@c.us'); finish({reply:'Old reply'});
    await assert.rejects(pending); assert.equal(f.items[0].review.status,'resolved');
});
test('excluded contacts are absent and cannot be drafted', async () => {
    const f = fixture({allowed:()=>false}); assert.deepEqual(f.review.list(),[]);
    await assert.rejects(f.review.draft('one'));
});
test('a failed durable sending claim prevents any network send', async () => {
    let fail = false; const f = fixture({save:()=>{if(fail) throw Error('disk');}});
    const d = await f.review.draft('one'); fail = true;
    await assert.rejects(f.review.approve('one',d.revision,'Reply')); assert.equal(f.sent.length,0);
});
test('incoming messages block approval before their summary finishes', async () => {
    const f = fixture(); const d = await f.review.draft('one');
    f.review.incoming('123@c.us'); const version = f.review.captureVersion('123@c.us');
    await assert.rejects(f.review.approve('one', d.revision, 'Reply'));
    f.review.incoming('123@c.us'); f.review.captured('123@c.us', version);
    assert.equal(f.review.list()[0].processing, true);
    f.review.captured('123@c.us', f.review.captureVersion('123@c.us'));
    await assert.rejects(f.review.approve('one', d.revision, 'Reply'));
    assert.equal(f.sent.length, 0);
});
test('empty generation preserves the prior draft', async () => {
    const f = fixture({generate:async()=>({reply:' '})});
    f.items[0].review = {status:'draft',text:'Keep me',revision:'prior'};
    await assert.rejects(f.review.draft('one')); assert.equal(f.items[0].review.text,'Keep me');
});
test('summary-only contacts remain visible but cannot draft or send', async () => {
    const f = fixture({canReply:()=>false}); assert.equal(f.review.list().length,1);
    assert.equal(f.review.list()[0].canReply,false);
    await assert.rejects(f.review.draft('one')); assert.equal(f.sent.length,0);
});
test('owner correction is saved without sending or retroactive auto-reply', async () => {
    let handoffs = 0;
    const f = fixture({handoff:()=>{handoffs++;}});
    f.items[0].category = 'promotion';
    f.items[0].policyDecision = 'quarantine';
    const result = await f.review.correct('one', 'delivery');
    assert.equal(result.category, 'delivery');
    assert.equal(f.review.list()[0].detectedCategory, 'promotion');
    assert.equal(f.review.list()[0].categorySource, 'owner');
    assert.equal(f.items[0].policyDecision, 'hold');
    assert.equal(f.sent.length, 0);
    assert.equal(handoffs, 1);
    await assert.rejects(f.review.correct('one', 'unsafe'));
});
