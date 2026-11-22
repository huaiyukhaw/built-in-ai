import { describe, expect, it } from 'vitest';
import { agendaStatus, checkFromNumbers, dueNudge, groundCheck, parseAgenda, timeBox, uncoveredQuestions } from '../src/lib/agenda';
import { scoreAgenda } from '../src/eval/score';
import { toHtml, toMarkdown } from '../src/lib/export';
import type { Meeting } from '../src/lib/model';

describe('parseAgenda', () => {
  it('takes one item per line, dropping bullets, numbers, blanks and repeats', () => {
    expect(parseAgenda('1. Payment gateway\n\n- Accessibility audit\n• Data   migration\nb) Training\npayment gateway\n')).toEqual(
      ['Payment gateway', 'Accessibility audit', 'Data migration', 'Training']);
  });
});

describe('agendaStatus', () => {
  const agenda = ['Payment gateway', 'Accessibility audit', 'Training'];
  it('takes the furthest status any window reached, matching titles without case', () => {
    expect(agendaStatus(agenda, [
      { agenda: { discussed: ['Payment gateway'], decided: [] } },
      {},
      { agenda: { discussed: ['payment gateway', 'Accessibility audit'], decided: ['Accessibility audit'] } },
    ])).toEqual(['discussed', 'decided', 'open']);
  });

  it('turns item numbers into titles, ignoring bad numbers; decided counts as discussed', () => {
    expect(checkFromNumbers(agenda, { discussed: [1, 1, 7, 0], decided: [3] })).toEqual({ discussed: ['Payment gateway', 'Training'], decided: ['Training'] });
  });

  it('lists items nobody got to as open questions', () => {
    expect(uncoveredQuestions(agenda, ['decided', 'open', 'discussed'])).toEqual(['Agenda item not covered: Accessibility audit']);
  });
});

describe('time box', () => {
  const start = Date.UTC(2026, 0, 5, 1, 0, 0);
  const m = { startedAt: start, plannedMinutes: 30 };
  const at = (min: number) => start + min * 60_000;

  it('says how long is left and what is not covered', () => {
    expect(timeBox(m, ['open', 'decided', 'open'], at(18))?.label).toBe('12 min left · 2 items not covered');
    expect(timeBox(m, ['decided'], at(30))?.label).toBe('Time’s up · all items covered');
    expect(timeBox(m, ['open'], at(35))?.label).toBe('5 min over · 1 item not covered');
    expect(timeBox({ startedAt: start }, ['open'], at(5))).toBeNull();
  });

  it('nudges once at 10 min left and once at time up, only while items are open', () => {
    const shown = new Set<number>();
    expect(dueNudge(timeBox(m, ['open'], at(15)), shown)).toBeNull();
    expect(dueNudge(timeBox(m, ['open'], at(20)), shown)).toBe(10);
    expect(dueNudge(timeBox(m, ['open'], at(25)), shown)).toBeNull();
    expect(dueNudge(timeBox(m, ['open'], at(30)), shown)).toBe(0);
    expect(dueNudge(timeBox(m, ['open'], at(31)), shown)).toBeNull();
  });

  it('shows one nudge, not two, when the meeting is already over time', () => {
    const shown = new Set<number>();
    expect(dueNudge(timeBox(m, ['open'], at(40)), shown)).toBe(0);
    expect(dueNudge(timeBox(m, ['open'], at(41)), shown)).toBeNull();
  });

  it('stays quiet when everything is covered', () => {
    expect(dueNudge(timeBox(m, ['decided'], at(25)), new Set())).toBeNull();
  });
});

describe('export', () => {
  const meeting: Meeting = {
    id: 'm', title: 'Portal sync', startedAt: Date.UTC(2026, 0, 5, 1), spokenLocale: 'en-US', captionLang: 'en', segments: [],
    agenda: ['Payment gateway', 'Training'],
    rolling: [{ from: 0, to: 0, summary: '', decisions: [], actionItems: [], openQuestions: [], extracted: true, agenda: { discussed: ['Payment gateway'], decided: ['Payment gateway'] } }],
    minutes: { generatedAt: 0, summary: '- ok', decisions: [], actionItems: [], openQuestions: ['Agenda item not covered: Training'] },
  };

  it('lists the agenda with each item’s status', () => {
    expect(toMarkdown(meeting)).toContain('## Agenda\n- [x] Payment gateway _(decided)_\n- [ ] Training _(not covered)_');
    expect(toHtml(meeting)).toContain('☐ Training <span style="color:#666">(not covered)</span>');
  });

  it('leaves the agenda out until minutes exist', () => {
    expect(toMarkdown({ ...meeting, minutes: undefined })).not.toContain('## Agenda');
  });
});

describe('eval: scoreAgenda', () => {
  it('accepts decided for discussed, but not the other way round', () => {
    expect(scoreAgenda(['A', 'B', 'C', 'D'], ['discussed', 'decided', 'open', 'open'], ['decided', 'discussed', 'open', 'discussed']))
      .toEqual({ total: 4, ok: 2, wrong: ['B: discussed ≠ decided', 'D: discussed ≠ open'] });
  });
});

describe('groundCheck', () => {
  const lines = ['Hafiz will migrate the reporting database by end of month.', 'The dashboard is green.', 'Do we still need the Saturday on-call rota?'];
  const agenda = ['Reporting database migration', 'Weekend on-call rota', 'Budget for next year'];

  it('drops items the stretch never mentions (eval: long-meeting "Budget for next year")', () => {
    expect(groundCheck(agenda, { discussed: ['Budget for next year', 'Weekend on-call rota'], decided: ['Budget for next year'] }, lines))
      // the migration line names every word of that item, so it counts even though the model left it out
      .toEqual({ discussed: ['Reporting database migration', 'Weekend on-call rota'], decided: [] });
  });

  it('marks an item decided when a decision or action item from the same stretch is about it', () => {
    expect(groundCheck(agenda, { discussed: ['Reporting database migration', 'Weekend on-call rota'], decided: [] }, lines,
      ['Hafiz will migrate the reporting database to the new server']))
      .toEqual({ discussed: ['Reporting database migration', 'Weekend on-call rota'], decided: ['Reporting database migration'] });
  });

  it('adds an item the model missed when one line names every word of it (demo: "who signs off UAT?")', () => {
    expect(groundCheck(['UAT sign-off', 'Staff training'], { discussed: [], decided: [] }, ['Open question: who signs off UAT on the client side?']))
      .toEqual({ discussed: ['UAT sign-off'], decided: [] });
  });
});
