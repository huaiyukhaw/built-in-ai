import { describe, expect, it } from 'vitest';
import { ModelGate } from '../src/lib/gate';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ModelGate.hold', () => {
  it('keeps background work waiting until released, including between live clips', async () => {
    const gate = new ModelGate();
    const release = gate.hold();
    let ran = false;
    void gate.background(async () => { ran = true; });
    await gate.live(async () => {}); // one clip done, more queued: still held
    await tick();
    expect(ran).toBe(false);
    release();
    await tick();
    expect(ran).toBe(true);
  });

  it('ignores a second release', async () => {
    const gate = new ModelGate();
    const a = gate.hold();
    const b = gate.hold();
    a();
    a();
    expect(gate.clear).toBe(false);
    b();
    expect(gate.clear).toBe(true);
  });
});
